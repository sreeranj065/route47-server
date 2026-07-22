import { db } from "../db.js";
import { NOTIFICATION_TYPES, type RecipientType } from "./notification-types.js";
import { getFirebaseAdminApp } from "./firebase-admin-app.js";

export interface PushPayload {
  notificationId: string;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * List/route updates must be data-only so the app (not the OS) posts the tray
 * alert — otherwise background delivery never marks read and open-app poll
 * duplicates the same event.
 */
const DATA_ONLY_TYPES = new Set<string>([
  NOTIFICATION_TYPES.SYNC_SILENT,
  NOTIFICATION_TYPES.CURRENT_LIST_ASSIGNED,
  NOTIFICATION_TYPES.CURRENT_LIST_UPDATED,
  NOTIFICATION_TYPES.STOPS_CHANGED,
  NOTIFICATION_TYPES.ROUTE_ASSIGNED,
  NOTIFICATION_TYPES.ROUTE_REASSIGNED,
  NOTIFICATION_TYPES.ROUTE_CANCELLED,
]);

function shouldSendDataOnly(type: string, silent?: boolean): boolean {
  return Boolean(silent) || DATA_ONLY_TYPES.has(type);
}

async function getFirebaseAdmin() {
  return getFirebaseAdminApp();
}

function listTokens(companyId: string, recipientType: RecipientType, recipientId: string): string[] {
  const rows = db
    .prepare(
      `SELECT token FROM push_tokens
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ?
       ORDER BY last_seen_at DESC`,
    )
    .all(companyId, recipientType, recipientId) as Array<{ token: string }>;
  return rows.map((r) => r.token);
}

export async function sendPushToRecipients(input: {
  companyId: string;
  recipientType: RecipientType;
  recipientId: string;
  payload: PushPayload;
  silent?: boolean;
}): Promise<{ ok: boolean; sent: number; error?: string }> {
  const tokens = listTokens(input.companyId, input.recipientType, input.recipientId);
  if (tokens.length === 0) {
    return { ok: false, sent: 0, error: "No push tokens registered" };
  }

  const admin = await getFirebaseAdmin();
  if (!admin) {
    return { ok: false, sent: 0, error: "FCM not configured on server" };
  }

  const dataOnly = shouldSendDataOnly(input.payload.type, input.silent);
  const data: Record<string, string> = {
    notificationId: input.payload.notificationId,
    type: input.payload.type,
    category: input.payload.category,
    priority: input.payload.priority,
    title: input.payload.title ?? "",
    body: input.payload.body ?? "",
    ...input.payload.data,
  };

  let sent = 0;
  let lastError: string | undefined;

  for (const token of tokens) {
    try {
      if (dataOnly) {
        await admin.messaging().send({
          token,
          data,
          android: { priority: "high" },
        });
      } else {
        await admin.messaging().send({
          token,
          notification: {
            title: input.payload.title,
            body: input.payload.body,
          },
          data,
          android: {
            priority: input.payload.priority === "high" ? "high" : "normal",
            notification: {
              channelId: input.payload.category,
            },
          },
        });
      }
      sent += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/not-registered|invalid-registration|registration-token-not-registered/i.test(lastError)) {
        db.prepare(`DELETE FROM push_tokens WHERE token = ?`).run(token);
      }
    }
  }

  return { ok: sent > 0, sent, error: sent > 0 ? undefined : lastError };
}
