import { db } from "../db.js";
import type { RecipientType } from "./notification-types.js";

export interface PushPayload {
  notificationId: string;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

let firebaseAdmin: typeof import("firebase-admin") | null = null;
let firebaseInitAttempted = false;

async function getFirebaseAdmin() {
  if (firebaseInitAttempted) return firebaseAdmin;
  firebaseInitAttempted = true;

  const json = process.env.ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!json && !path) {
    return null;
  }

  try {
    const admin = await import("firebase-admin");
    if (admin.apps.length === 0) {
      if (json) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(json) as import("firebase-admin").ServiceAccount),
        });
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
      }
    }
    firebaseAdmin = admin;
    return admin;
  } catch (error) {
    console.warn("Firebase Admin SDK unavailable — push delivery will be in-app only.", error);
    return null;
  }
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

  const data: Record<string, string> = {
    notificationId: input.payload.notificationId,
    type: input.payload.type,
    category: input.payload.category,
    priority: input.payload.priority,
    ...input.payload.data,
  };

  let sent = 0;
  let lastError: string | undefined;

  for (const token of tokens) {
    try {
      if (input.silent) {
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
