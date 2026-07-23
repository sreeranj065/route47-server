import { Hono } from "hono";
import { db } from "../db.js";
import {
  notificationToJson,
  registerPushToken,
  unregisterPushToken,
} from "../lib/notification-service.js";
import { companyRoutes } from "./auth.js";

function resolveRecipient(c: {
  get: (key: "admin" | "driverId") => import("../lib/admin-auth.js").AdminIdentity | string | undefined;
}) {
  const admin = c.get("admin");
  if (admin && typeof admin !== "string") {
    return { recipientType: "admin" as const, recipientId: admin.id };
  }

  const driverId = c.get("driverId");
  if (typeof driverId === "string" && driverId.trim()) {
    return { recipientType: "driver" as const, recipientId: driverId.trim() };
  }

  return null;
}

companyRoutes.post("/route47/companies/:companyId/notifications/push-token", async (c) => {
  const companyId = c.req.param("companyId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const body = await c.req.json<{
    token?: string;
    deviceId?: string;
    platform?: string;
    appVersion?: string;
  }>();

  const token = body.token?.trim() ?? "";
  if (!token) return c.json({ message: "token is required" }, 400);

  registerPushToken({
    companyId,
    recipientType: recipient.recipientType,
    recipientId: recipient.recipientId,
    token,
    deviceId: body.deviceId,
    platform: body.platform,
    appVersion: body.appVersion,
  });

  return c.json({ message: "Push token registered.", token });
});

companyRoutes.delete("/route47/companies/:companyId/notifications/push-token", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({ token: "" }));
  const token = body.token?.trim() ?? c.req.query("token")?.trim() ?? "";
  if (!token) return c.json({ message: "token is required" }, 400);
  unregisterPushToken(token);
  return c.json({ message: "Push token removed." });
});

/** Diagnostics: why background chat alerts may not reach the tray. */
companyRoutes.get("/route47/companies/:companyId/notifications/push-status", async (c) => {
  const companyId = c.req.param("companyId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const { isFirebaseAdminConfigured } = await import("../lib/firebase-admin-app.js");
  const pushConfigured = isFirebaseAdminConfigured();
  const tokenCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM push_tokens
         WHERE company_id = ? AND recipient_type = ? AND recipient_id = ?`,
      )
      .get(companyId, recipient.recipientType, recipient.recipientId) as { c: number }
  ).c;

  const recentFailures = db
    .prepare(
      `SELECT id, type, push_last_error AS pushLastError, push_attempts AS pushAttempts, created_at AS createdAt
       FROM notifications
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ?
         AND push_sent_at IS NULL AND push_last_error IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 5`,
    )
    .all(companyId, recipient.recipientType, recipient.recipientId) as Array<{
      id: string;
      type: string;
      pushLastError: string;
      pushAttempts: number;
      createdAt: number;
    }>;

  return c.json({
    pushConfigured,
    tokenCount,
    recipientType: recipient.recipientType,
    recipientId: recipient.recipientId,
    backgroundPushReady: pushConfigured && tokenCount > 0,
    recentFailures,
    hint: !pushConfigured
      ? "Set ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON on the customer server (same Firebase project as the apps: route47-admin)."
      : tokenCount === 0
        ? "Open this app once while connected to the company server so it can register an FCM token."
        : "Push looks ready — background message alerts should appear in the notification shade.",
  });
});

companyRoutes.get("/route47/companies/:companyId/notifications", (c) => {
  const companyId = c.req.param("companyId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const unreadOnly = c.req.query("unreadOnly") === "1";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);

  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ?
       ${unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(companyId, recipient.recipientType, recipient.recipientId, limit) as Array<{
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
    }>;

  const unreadCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ? AND read_at IS NULL`,
    )
    .get(companyId, recipient.recipientType, recipient.recipientId) as { c: number };

  return c.json({
    notifications: rows.map(notificationToJson),
    unreadCount: unreadCount.c,
  });
});

companyRoutes.post("/route47/companies/:companyId/notifications/:notificationId/read", (c) => {
  const companyId = c.req.param("companyId");
  const notificationId = c.req.param("notificationId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const result = db
    .prepare(
      `UPDATE notifications SET read_at = ?
       WHERE id = ? AND company_id = ? AND recipient_type = ? AND recipient_id = ? AND read_at IS NULL`,
    )
    .run(Date.now(), notificationId, companyId, recipient.recipientType, recipient.recipientId);

  if (result.changes === 0) {
    return c.json({ message: "Notification not found or already read." }, 404);
  }

  return c.json({ message: "Marked as read.", id: notificationId });
});

companyRoutes.post("/route47/companies/:companyId/notifications/read-all", (c) => {
  const companyId = c.req.param("companyId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const result = db
    .prepare(
      `UPDATE notifications SET read_at = ?
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ? AND read_at IS NULL`,
    )
    .run(Date.now(), companyId, recipient.recipientType, recipient.recipientId);

  return c.json({ message: "All notifications marked as read.", updated: result.changes });
});

companyRoutes.get("/route47/companies/:companyId/notifications/preferences", (c) => {
  const companyId = c.req.param("companyId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const rows = db
    .prepare(
      `SELECT preference_key AS key, enabled FROM notification_preferences
       WHERE company_id = ? AND recipient_type = ? AND recipient_id = ?
       ORDER BY preference_key`,
    )
    .all(companyId, recipient.recipientType, recipient.recipientId) as Array<{
      key: string;
      enabled: number;
    }>;

  return c.json({
    preferences: rows.map((row) => ({ key: row.key, enabled: row.enabled === 1 })),
  });
});

companyRoutes.put("/route47/companies/:companyId/notifications/preferences", async (c) => {
  const companyId = c.req.param("companyId");
  const recipient = resolveRecipient(c);
  if (!recipient) return c.json({ message: "Authentication required." }, 401);

  const body = await c.req.json<{ preferences?: Array<{ key: string; enabled: boolean }> }>();
  const preferences = body.preferences ?? [];
  const ts = Date.now();

  const upsert = db.prepare(
    `INSERT INTO notification_preferences (company_id, recipient_type, recipient_id, preference_key, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, recipient_type, recipient_id, preference_key)
     DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  );

  for (const pref of preferences) {
    if (!pref.key?.trim()) continue;
    upsert.run(
      companyId,
      recipient.recipientType,
      recipient.recipientId,
      pref.key.trim(),
      pref.enabled ? 1 : 0,
      ts,
    );
  }

  return c.json({ message: "Notification preferences saved." });
});

companyRoutes.post("/route47/companies/:companyId/admin/notifications/announce", async (c) => {
  const admin = c.get("admin");
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (admin.role === "viewer") return c.json({ message: "Viewers cannot send announcements." }, 403);

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{ title?: string; body?: string; driverId?: string }>();
  const title = body.title?.trim() ?? "";
  const message = body.body?.trim() ?? "";
  if (!title || !message) return c.json({ message: "title and body are required" }, 400);

  const { notifyAllAdmins, notifyDriver } = await import("../lib/notification-service.js");
  const { NOTIFICATION_TYPES } = await import("../lib/notification-types.js");

  if (body.driverId?.trim()) {
    notifyDriver(companyId, body.driverId.trim(), NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT, title, message, {
      senderAdminId: admin.id,
    });
  } else {
    notifyAllAdmins(companyId, NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT, title, message, {
      senderAdminId: admin.id,
    });
  }

  return c.json({ message: "Announcement sent." });
});
