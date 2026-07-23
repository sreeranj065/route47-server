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
    console.warn(
      `[push] No tokens for ${input.recipientType}/${input.recipientId} type=${input.payload.type}`,
    );
    return { ok: false, sent: 0, error: "No push tokens registered" };
  }

  const admin = await getFirebaseAdmin();
  if (!admin) {
    const { getFirebaseInitError } = await import("./firebase-admin-app.js");
    const detail = getFirebaseInitError() || "set ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON";
    console.warn(`[push] FCM not configured — ${detail}`);
    return { ok: false, sent: 0, error: `FCM not configured on server: ${detail}` };
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
          android: {
            priority: "high",
            // Firebase Admin ttl is milliseconds (not seconds).
            ttl: 120_000,
          },
        });
      } else {
        // Chat / alerts: high priority + long TTL so Doze still delivers like WhatsApp.
        const isChat = input.payload.type === NOTIFICATION_TYPES.MESSAGE;
        const useHighPriority = isChat || input.payload.priority === "high";
        await admin.messaging().send({
          token,
          notification: {
            title: input.payload.title,
            body: input.payload.body,
          },
          data,
          android: {
            priority: useHighPriority ? "high" : "normal",
            // Firebase Admin ttl is milliseconds.
            ttl: isChat || useHighPriority ? 86_400_000 : 120_000,
            notification: {
              channelId: input.payload.category || (isChat ? "messages" : "system"),
              ...(isChat
                ? {
                    priority: "high" as const,
                    defaultSound: true,
                    defaultVibrateTimings: true,
                  }
                : {}),
            },
          },
        });
      }
      sent += 1;
    } catch (error) {
      const err = error as { code?: string; message?: string; errorInfo?: { code?: string; message?: string } };
      lastError =
        err?.errorInfo?.message ||
        err?.message ||
        (error instanceof Error ? error.message : String(error));
      const code = err?.errorInfo?.code || err?.code || "";
      console.warn(
        `[push] FCM send failed recipient=${input.recipientType}/${input.recipientId} type=${input.payload.type} code=${code} err=${lastError}`,
      );
      if (
        /not-registered|invalid-registration|registration-token-not-registered|messaging\/registration-token-not-registered/i.test(
          `${code} ${lastError}`,
        )
      ) {
        db.prepare(`DELETE FROM push_tokens WHERE token = ?`).run(token);
      }
    }
  }

  return { ok: sent > 0, sent, error: sent > 0 ? undefined : lastError };
}
