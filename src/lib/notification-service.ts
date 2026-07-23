import { db } from "../db.js";
import { rid, now } from "./util.js";
import { adminHasBranchAccess } from "./admin-auth.js";
import {
  NOTIFICATION_TYPES,
  TYPE_CATEGORY,
  type NotificationPriority,
  type RecipientType,
} from "./notification-types.js";
import { sendPushToRecipients, type PushPayload } from "./push-service.js";

export interface CreateNotificationInput {
  companyId: string;
  recipientType: RecipientType;
  recipientId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  priority?: NotificationPriority;
  silent?: boolean;
  category?: string;
  branchId?: string;
}

const DEFAULT_PREFERENCE_KEYS = [
  "routes",
  "proofs",
  "drivers",
  "announcements",
  "messages",
  "system",
  "billing",
] as const;

export function ensureDefaultPreferences(
  companyId: string,
  recipientType: RecipientType,
  recipientId: string,
) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notification_preferences
     (company_id, recipient_type, recipient_id, preference_key, enabled, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  );
  const ts = now();
  for (const key of DEFAULT_PREFERENCE_KEYS) {
    insert.run(companyId, recipientType, recipientId, key, ts);
  }
}

function isPreferenceEnabled(
  companyId: string,
  recipientType: RecipientType,
  recipientId: string,
  category: string,
): boolean {
  ensureDefaultPreferences(companyId, recipientType, recipientId);
  const row = db
    .prepare(
      `SELECT enabled FROM notification_preferences
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ? AND preference_key = ?`,
    )
    .get(companyId, recipientType, recipientId, category) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

/** Types that should update one unread row per recipient+routeRunId instead of stacking. */
const COLLAPSIBLE_TYPES = new Set<string>([
  NOTIFICATION_TYPES.CURRENT_LIST_ASSIGNED,
  NOTIFICATION_TYPES.CURRENT_LIST_UPDATED,
  NOTIFICATION_TYPES.STOPS_CHANGED,
  NOTIFICATION_TYPES.ROUTE_ASSIGNED,
  NOTIFICATION_TYPES.ROUTE_REASSIGNED,
  NOTIFICATION_TYPES.ROUTE_CANCELLED,
]);

function shouldCollapse(type: string, silent?: boolean): boolean {
  if (silent || type === NOTIFICATION_TYPES.SYNC_SILENT) return false;
  return COLLAPSIBLE_TYPES.has(type);
}

/**
 * Insert or refresh an unread notification so list-update spam becomes one row
 * per (recipient, type, routeRunId).
 */
export function createNotification(input: CreateNotificationInput): string {
  const category = input.category ?? TYPE_CATEGORY[input.type] ?? "system";
  const priority = input.priority ?? "normal";
  const dataJson = JSON.stringify(input.data ?? {});
  const createdAt = now();
  const routeRunId = String(input.data?.routeRunId ?? "").trim();
  const isSilent =
    Boolean(input.silent) || input.type === NOTIFICATION_TYPES.SYNC_SILENT;

  let id = rid("notif");
  let reused = false;

  if (shouldCollapse(input.type, input.silent) && routeRunId) {
    const existing = db
      .prepare(
        `SELECT id, title, body, data_json AS dataJson FROM notifications
         WHERE company_id = ?
           AND recipient_type = ?
           AND recipient_id = ?
           AND type = ?
           AND read_at IS NULL
           AND instr(data_json, ?) > 0
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(
        input.companyId,
        input.recipientType,
        input.recipientId,
        input.type,
        `"routeRunId":"${routeRunId}"`,
      ) as { id: string; title: string; body: string; dataJson: string } | undefined;

    if (existing?.id) {
      id = existing.id;
      const sameContent =
        existing.title === input.title &&
        existing.body === input.body &&
        existing.dataJson === dataJson;
      // Skip re-push when nothing meaningful changed (stops open-app / republish spam).
      if (sameContent) {
        return id;
      }
      reused = true;
      db.prepare(
        `UPDATE notifications
         SET title = ?, body = ?, data_json = ?, category = ?, priority = ?,
             branch_id = ?, created_at = ?, push_sent_at = NULL, push_attempts = 0, push_last_error = NULL
         WHERE id = ?`,
      ).run(
        input.title,
        input.body,
        dataJson,
        category,
        priority,
        input.branchId ?? "",
        createdAt,
        id,
      );
    }
  }

  if (!reused) {
    db.prepare(
      `INSERT INTO notifications (
        id, company_id, recipient_type, recipient_id, type, category, priority,
        title, body, data_json, branch_id, read_at, created_at, push_sent_at, push_attempts, push_last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL)`,
    ).run(
      id,
      input.companyId,
      input.recipientType,
      input.recipientId,
      input.type,
      category,
      priority,
      input.title,
      input.body,
      dataJson,
      input.branchId ?? "",
      createdAt,
    );
  }

  // Visible notifications respect preference toggles; silent sync always wakes the device.
  if (
    isSilent ||
    isPreferenceEnabled(input.companyId, input.recipientType, input.recipientId, category)
  ) {
    // Chat + plan wakes must not wait — background tray delivery depends on FCM
    // leaving the server immediately while the device can still be reached.
    const wakeNow =
      isSilent ||
      input.type === NOTIFICATION_TYPES.SYNC_SILENT ||
      input.type === NOTIFICATION_TYPES.MESSAGE ||
      priority === "high" ||
      COLLAPSIBLE_TYPES.has(input.type);
    queuePushDelivery(id, { immediate: wakeNow });
  }

  return id;
}

export function notifyDriver(
  companyId: string,
  driverId: string,
  type: string,
  title: string,
  body: string,
  data?: Record<string, string>,
  options?: { silent?: boolean; priority?: NotificationPriority; branchId?: string },
) {
  if (!driverId) return null;
  return createNotification({
    companyId,
    recipientType: "driver",
    recipientId: driverId,
    type,
    title,
    body,
    data,
    silent: options?.silent,
    priority: options?.priority,
    branchId: options?.branchId,
  });
}

export function notifyAllAdmins(
  companyId: string,
  type: string,
  title: string,
  body: string,
  data?: Record<string, string>,
  options?: { branchId?: string; excludeAdminId?: string; priority?: NotificationPriority },
) {
  const branchId = options?.branchId?.trim() ?? "";
  const admins = db
    .prepare(
      `SELECT id FROM admins
       WHERE company_id = ? AND status = 'active' AND disabled_at IS NULL`,
    )
    .all(companyId) as Array<{ id: string }>;

  const ids: string[] = [];
  const notifiedRecipientIds = new Set<string>();

  // Always include legacy recipientId "owner". The Admin app authenticates with the
  // company API key as identity id "owner", so FCM tokens are stored under "owner".
  // Skipping it whenever real admin rows exist left background chat with pushConfigured
  // true but tokenCount 0 for the device that actually registered.
  if (
    options?.excludeAdminId !== "owner" &&
    (!branchId || adminHasBranchAccess(companyId, "owner", branchId))
  ) {
    notifiedRecipientIds.add("owner");
    ids.push(
      createNotification({
        companyId,
        recipientType: "admin",
        recipientId: "owner",
        type,
        title,
        body,
        data: { ...data, adminId: "owner" },
        branchId: options?.branchId,
        priority: options?.priority,
      }),
    );
  }

  for (const admin of admins) {
    if (options?.excludeAdminId && admin.id === options.excludeAdminId) continue;
    if (branchId && !adminHasBranchAccess(companyId, admin.id, branchId)) continue;
    if (notifiedRecipientIds.has(admin.id)) continue;
    notifiedRecipientIds.add(admin.id);
    ids.push(
      createNotification({
        companyId,
        recipientType: "admin",
        recipientId: admin.id,
        type,
        title,
        body,
        data: { ...data, adminId: admin.id },
        branchId: options?.branchId,
        priority: options?.priority,
      }),
    );
  }

  return ids;
}

function queuePushDelivery(notificationId: string, options?: { immediate?: boolean }) {
  const run = () =>
    deliverPush(notificationId).catch((err) => {
      console.warn(`Push delivery failed for ${notificationId}:`, err);
    });
  // Silent / plan-wake pushes must not wait on the event loop tick — drivers
  // otherwise fall back to a multi-second poll before seeing Current List edits.
  if (options?.immediate) {
    void run();
    return;
  }
  setImmediate(run);
}

export async function deliverPush(notificationId: string): Promise<boolean> {
  const row = db
    .prepare(`SELECT * FROM notifications WHERE id = ?`)
    .get(notificationId) as
    | {
        id: string;
        company_id: string;
        recipient_type: RecipientType;
        recipient_id: string;
        type: string;
        category: string;
        priority: string;
        title: string;
        body: string;
        data_json: string;
        push_attempts: number;
      }
    | undefined;

  if (!row) return false;

  const payload: PushPayload = {
    notificationId: row.id,
    type: row.type,
    category: row.category,
    priority: row.priority,
    title: row.title,
    body: row.body,
    data: JSON.parse(row.data_json || "{}") as Record<string, string>,
  };

  const result = await sendPushToRecipients({
    companyId: row.company_id,
    recipientType: row.recipient_type,
    recipientId: row.recipient_id,
    payload,
    silent: row.type === NOTIFICATION_TYPES.SYNC_SILENT,
  });

  db.prepare(
    `UPDATE notifications
     SET push_sent_at = ?, push_attempts = push_attempts + 1, push_last_error = ?
     WHERE id = ?`,
  ).run(result.ok ? now() : null, result.error ?? null, notificationId);

  return result.ok;
}

export async function retryFailedPushDeliveries(limit = 25) {
  const rows = db
    .prepare(
      `SELECT id FROM notifications
       WHERE push_sent_at IS NULL AND push_attempts < 5
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;

  for (const row of rows) {
    await deliverPush(row.id);
  }
}

export function notificationToJson(row: {
  id: string;
  company_id: string;
  recipient_type: string;
  recipient_id: string;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  data_json: string;
  branch_id: string;
  read_at: number | null;
  created_at: number;
}) {
  return {
    id: row.id,
    companyId: row.company_id,
    recipientType: row.recipient_type,
    recipientId: row.recipient_id,
    type: row.type,
    category: row.category,
    priority: row.priority,
    title: row.title,
    body: row.body,
    data: JSON.parse(row.data_json || "{}") as Record<string, string>,
    branchId: row.branch_id || undefined,
    read: row.read_at != null,
    readAtMillis: row.read_at ?? undefined,
    createdAtMillis: row.created_at,
  };
}

export function registerPushToken(input: {
  companyId: string;
  recipientType: RecipientType;
  recipientId: string;
  token: string;
  deviceId?: string;
  platform?: string;
  appVersion?: string;
}) {
  const ts = now();
  db.prepare(
    `INSERT INTO push_tokens (token, company_id, recipient_type, recipient_id, device_id, platform, app_version, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       company_id = excluded.company_id,
       recipient_type = excluded.recipient_type,
       recipient_id = excluded.recipient_id,
       device_id = excluded.device_id,
       platform = excluded.platform,
       app_version = excluded.app_version,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    input.token,
    input.companyId,
    input.recipientType,
    input.recipientId,
    input.deviceId ?? "",
    input.platform ?? "android",
    input.appVersion ?? "",
    ts,
    ts,
    ts,
  );

  ensureDefaultPreferences(input.companyId, input.recipientType, input.recipientId);
}

export function unregisterPushToken(token: string) {
  db.prepare(`DELETE FROM push_tokens WHERE token = ?`).run(token);
}
