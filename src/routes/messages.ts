import { db, getCompany } from "../db.js";
import { adminCanAccessDriver, driverBranchFilterSql } from "../lib/branch-filter.js";
import { NOTIFICATION_TYPES } from "../lib/notification-types.js";
import { notifyAllAdmins, notifyDriver } from "../lib/notification-service.js";
import { hasAdminAccess } from "../lib/route-admin.js";
import { now, rid } from "../lib/util.js";
import { companyRoutes } from "./auth.js";

type MessageRow = {
  id: string;
  company_id: string;
  conversation_driver_id: string;
  sender_type: string;
  body: string;
  attachment_url: string;
  mime_type: string;
  created_at: number;
  read_at: number | null;
};

function requireAdmin(c: { get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined }) {
  return hasAdminAccess(c);
}

function messageToJson(row: MessageRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    conversationDriverId: row.conversation_driver_id,
    senderType: row.sender_type,
    body: row.body,
    attachmentUrl: row.attachment_url || undefined,
    mimeType: row.mime_type || undefined,
    createdAtMillis: row.created_at,
    readAtMillis: row.read_at ?? undefined,
    read: row.read_at != null,
  };
}

function previewBody(body: string, maxLen = 120): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function notifyMessageRecipient(input: {
  companyId: string;
  senderType: "admin" | "driver";
  driverId: string;
  messageId: string;
  body: string;
  driverName?: string;
}) {
  const preview = previewBody(input.body) || "Attachment";
  const data = {
    messageId: input.messageId,
    driverId: input.driverId,
    conversationDriverId: input.driverId,
  };

  if (input.senderType === "admin") {
    notifyDriver(
      input.companyId,
      input.driverId,
      NOTIFICATION_TYPES.MESSAGE,
      "New message from dispatch",
      preview,
      data,
    );
    return;
  }

  const title = input.driverName ? `Message from ${input.driverName}` : "New driver message";
  notifyAllAdmins(input.companyId, NOTIFICATION_TYPES.MESSAGE, title, preview, data);
}

function upsertConversation(companyId: string, driverId: string, lastMessageAt: number) {
  db.prepare(
    `INSERT INTO conversations (company_id, driver_id, last_message_at)
     VALUES (?, ?, ?)
     ON CONFLICT(company_id, driver_id) DO UPDATE SET last_message_at = excluded.last_message_at`,
  ).run(companyId, driverId, lastMessageAt);
}

function insertMessage(input: {
  companyId: string;
  driverId: string;
  senderType: "admin" | "driver";
  body: string;
  attachmentUrl?: string;
  mimeType?: string;
}) {
  const createdAt = now();
  const messageId = rid("msg");

  db.prepare(
    `INSERT INTO messages (
      id, company_id, conversation_driver_id, sender_type, body,
      attachment_url, mime_type, created_at, read_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    messageId,
    input.companyId,
    input.driverId,
    input.senderType,
    input.body,
    input.attachmentUrl ?? "",
    input.mimeType ?? "",
    createdAt,
  );

  upsertConversation(input.companyId, input.driverId, createdAt);

  return { messageId, createdAt };
}

function listMessages(companyId: string, driverId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT id, company_id, conversation_driver_id, sender_type, body,
              attachment_url, mime_type, created_at, read_at
       FROM messages
       WHERE company_id = ? AND conversation_driver_id = ?
       ORDER BY created_at ASC`,
    )
    .all(companyId, driverId) as MessageRow[];
}

function getDriverRecord(companyId: string, driverId: string) {
  return db
    .prepare(
      `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId
       FROM drivers WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, driverId) as
    | {
        id: string;
        displayName: string;
        username: string;
        vehicleId: string;
        branchId: string;
      }
    | undefined;
}

companyRoutes.get("/route47/companies/:companyId/messages/conversations", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const admin = c.get("admin");
  const branchFilter = driverBranchFilterSql(companyId, admin, "c.driver_id");

  const rows = db
    .prepare(
      `SELECT
         c.driver_id AS driverId,
         c.last_message_at AS lastMessageAtMillis,
         d.display_name AS driverDisplayName,
         d.username AS driverUsername,
         d.vehicle_id AS vehicleId,
         m.id AS lastMessageId,
         m.sender_type AS lastMessageSenderType,
         m.body AS lastMessageBody,
         m.attachment_url AS lastMessageAttachmentUrl,
         m.mime_type AS lastMessageMimeType,
         m.created_at AS lastMessageCreatedAtMillis
       FROM conversations c
       JOIN drivers d ON d.company_id = c.company_id AND d.id = c.driver_id
       LEFT JOIN messages m ON m.id = (
         SELECT id FROM messages
         WHERE company_id = c.company_id AND conversation_driver_id = c.driver_id
         ORDER BY created_at DESC
         LIMIT 1
       )
       WHERE c.company_id = ?${branchFilter.clause}
       ORDER BY c.last_message_at DESC`,
    )
    .all(companyId, ...(branchFilter.params as string[])) as Array<{
      driverId: string;
      lastMessageAtMillis: number;
      driverDisplayName: string;
      driverUsername: string;
      vehicleId: string;
      lastMessageId: string | null;
      lastMessageSenderType: string | null;
      lastMessageBody: string | null;
      lastMessageAttachmentUrl: string | null;
      lastMessageMimeType: string | null;
      lastMessageCreatedAtMillis: number | null;
    }>;

  return c.json({
    conversations: rows.map((row) => ({
      driverId: row.driverId,
      driverName: row.driverDisplayName || row.driverUsername || "Driver",
      driverUsername: row.driverUsername,
      vehicleId: row.vehicleId || undefined,
      lastMessageAtMillis: row.lastMessageAtMillis,
      lastMessage: row.lastMessageId
        ? {
            id: row.lastMessageId,
            senderType: row.lastMessageSenderType,
            body: row.lastMessageBody ?? "",
            attachmentUrl: row.lastMessageAttachmentUrl || undefined,
            mimeType: row.lastMessageMimeType || undefined,
            createdAtMillis: row.lastMessageCreatedAtMillis ?? row.lastMessageAtMillis,
            preview: previewBody(row.lastMessageBody ?? "") || (row.lastMessageAttachmentUrl ? "Attachment" : ""),
          }
        : undefined,
    })),
  });
});

companyRoutes.get("/route47/companies/:companyId/messages/conversations/me", (c) => {
  const companyId = c.req.param("companyId");
  const driverId = c.get("driverId")?.trim() ?? "";
  if (!driverId) {
    return c.json({ message: "Driver authentication required." }, 401);
  }
  if (requireAdmin(c)) {
    return c.json({ message: "Driver authentication required." }, 401);
  }

  const driver = getDriverRecord(companyId, driverId);
  if (!driver) {
    return c.json({ message: "Driver not found." }, 404);
  }

  const company = getCompany(companyId);
  const messages = listMessages(companyId, driverId);

  return c.json({
    conversation: {
      driverId,
      driverName: driver.displayName || driver.username || "Driver",
      dispatchName: company?.name ? `${company.name} Dispatch` : "Dispatch",
      companyId,
      companyName: company?.name ?? "",
      messages: messages.map(messageToJson),
    },
  });
});

companyRoutes.post("/route47/companies/:companyId/messages/conversations/me/messages", async (c) => {
  const companyId = c.req.param("companyId");
  const driverId = c.get("driverId")?.trim() ?? "";
  if (!driverId) {
    return c.json({ message: "Driver authentication required." }, 401);
  }
  if (requireAdmin(c)) {
    return c.json({ message: "Driver authentication required." }, 401);
  }

  const driver = getDriverRecord(companyId, driverId);
  if (!driver) {
    return c.json({ message: "Driver not found." }, 404);
  }

  const body = await c.req.json<{
    body?: string;
    attachmentUrl?: string;
    mimeType?: string;
  }>();

  const text = body.body?.trim() ?? "";
  const attachmentUrl = body.attachmentUrl?.trim() ?? "";
  const mimeType = body.mimeType?.trim() ?? "";

  if (!text && !attachmentUrl) {
    return c.json({ message: "body or attachmentUrl is required." }, 400);
  }

  const { messageId, createdAt } = insertMessage({
    companyId,
    driverId,
    senderType: "driver",
    body: text,
    attachmentUrl: attachmentUrl || undefined,
    mimeType: mimeType || undefined,
  });

  notifyMessageRecipient({
    companyId,
    senderType: "driver",
    driverId,
    messageId,
    body: text || "Attachment",
    driverName: driver.displayName || driver.username,
  });

  const row = db
    .prepare(
      `SELECT id, company_id, conversation_driver_id, sender_type, body,
              attachment_url, mime_type, created_at, read_at
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as MessageRow;

  return c.json({ message: "Message sent.", sentMessage: messageToJson(row), createdAtMillis: createdAt }, 201);
});

companyRoutes.get("/route47/companies/:companyId/messages/conversations/:driverId", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const driverId = c.req.param("driverId")?.trim() ?? "";
  const admin = c.get("admin");

  if (!driverId) {
    return c.json({ message: "driverId is required." }, 400);
  }

  const driver = getDriverRecord(companyId, driverId);
  if (!driver) {
    return c.json({ message: "Driver not found." }, 404);
  }

  if (!adminCanAccessDriver(companyId, admin, driverId)) {
    return c.json({ message: "You do not have access to this driver." }, 403);
  }

  const messages = listMessages(companyId, driverId);

  return c.json({
    conversation: {
      driverId,
      driverName: driver.displayName || driver.username || "Driver",
      driverUsername: driver.username,
      vehicleId: driver.vehicleId || undefined,
      branchId: driver.branchId || undefined,
      messages: messages.map(messageToJson),
    },
  });
});

companyRoutes.post("/route47/companies/:companyId/messages/conversations/:driverId", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const driverId = c.req.param("driverId")?.trim() ?? "";
  const admin = c.get("admin");

  if (!driverId) {
    return c.json({ message: "driverId is required." }, 400);
  }

  const driver = getDriverRecord(companyId, driverId);
  if (!driver) {
    return c.json({ message: "Driver not found." }, 404);
  }

  if (!adminCanAccessDriver(companyId, admin, driverId)) {
    return c.json({ message: "You do not have access to this driver." }, 403);
  }

  const body = await c.req.json<{
    body?: string;
    attachmentUrl?: string;
    mimeType?: string;
  }>();

  const text = body.body?.trim() ?? "";
  const attachmentUrl = body.attachmentUrl?.trim() ?? "";
  const mimeType = body.mimeType?.trim() ?? "";

  if (!text && !attachmentUrl) {
    return c.json({ message: "body or attachmentUrl is required." }, 400);
  }

  const { messageId, createdAt } = insertMessage({
    companyId,
    driverId,
    senderType: "admin",
    body: text,
    attachmentUrl: attachmentUrl || undefined,
    mimeType: mimeType || undefined,
  });

  notifyMessageRecipient({
    companyId,
    senderType: "admin",
    driverId,
    messageId,
    body: text || "Attachment",
  });

  const row = db
    .prepare(
      `SELECT id, company_id, conversation_driver_id, sender_type, body,
              attachment_url, mime_type, created_at, read_at
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as MessageRow;

  return c.json({ message: "Message sent.", sentMessage: messageToJson(row), createdAtMillis: createdAt }, 201);
});
