import fs from "node:fs";
import path from "node:path";
import { db, getCompany } from "../db.js";
import { ensureBranchOperationalLayout, getDriverBranchId } from "../branch-storage.js";
import {
  adminCanAccessDriver,
  defaultBranchId,
  driverBranchFilterSql,
  getAdminAllowedBranchIds,
} from "../lib/branch-filter.js";
import { getAdminDefaultBranchId } from "../lib/admin-auth.js";
import { NOTIFICATION_TYPES } from "../lib/notification-types.js";
import { notifyAllAdmins, notifyDriver } from "../lib/notification-service.js";
import { hasAdminAccess } from "../lib/route-admin.js";
import { now, rid } from "../lib/util.js";
import { companyRoutes, type AuthEnv } from "./auth.js";
import type { Context } from "hono";

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
  edited_at: number | null;
  deleted_at: number | null;
};

const MESSAGE_SELECT_COLUMNS = `id, company_id, conversation_driver_id, sender_type, body,
              attachment_url, mime_type, created_at, read_at, edited_at, deleted_at`;

function requireAdmin(c: { get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined }) {
  return hasAdminAccess(c);
}

function messageToJson(row: MessageRow) {
  const deleted = row.deleted_at != null;
  return {
    id: row.id,
    companyId: row.company_id,
    conversationDriverId: row.conversation_driver_id,
    senderType: row.sender_type,
    body: deleted ? "" : row.body,
    attachmentUrl: deleted ? undefined : row.attachment_url || undefined,
    mimeType: deleted ? undefined : row.mime_type || undefined,
    createdAtMillis: row.created_at,
    readAtMillis: row.read_at ?? undefined,
    read: row.read_at != null,
    editedAtMillis: row.edited_at ?? undefined,
    deleted,
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
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM messages
       WHERE company_id = ? AND conversation_driver_id = ?
       ORDER BY created_at ASC`,
    )
    .all(companyId, driverId) as MessageRow[];
}

function getMessage(companyId: string, messageId: string): MessageRow | undefined {
  return db
    .prepare(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM messages
       WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, messageId) as MessageRow | undefined;
}

/**
 * Returns the caller's role for mutating a specific message, or null when
 * the caller may not edit/delete it. Admins own admin-sent messages in any
 * conversation they can access; drivers own driver-sent messages in their
 * own conversation.
 */
function resolveMessageMutationRole(
  c: {
    get: ((key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined) &
      ((key: "driverId") => string | undefined);
  },
  companyId: string,
  message: MessageRow,
): "admin" | "driver" | null {
  if (hasAdminAccess(c)) {
    if (message.sender_type !== "admin") return null;
    const admin = c.get("admin");
    if (!adminCanAccessDriver(companyId, admin, message.conversation_driver_id)) return null;
    return "admin";
  }

  const driverId = c.get("driverId")?.trim() ?? "";
  if (
    driverId &&
    message.sender_type === "driver" &&
    message.conversation_driver_id === driverId
  ) {
    return "driver";
  }

  return null;
}

function deleteAttachmentFileForUrl(companyId: string, attachmentUrl: string) {
  const match = attachmentUrl.match(/\/messages\/attachments\/([^/]+)\/file/);
  if (!match) return;

  const attachmentId = match[1];
  const row = db
    .prepare(`SELECT file_path FROM message_attachments WHERE company_id = ? AND id = ?`)
    .get(companyId, attachmentId) as { file_path: string } | undefined;

  if (row?.file_path) {
    try {
      fs.unlinkSync(row.file_path);
    } catch {
      // File may already be gone; ignore.
    }
  }
  db.prepare(`DELETE FROM message_attachments WHERE company_id = ? AND id = ?`).run(
    companyId,
    attachmentId,
  );
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
         m.created_at AS lastMessageCreatedAtMillis,
         (
           SELECT COUNT(*)
           FROM messages um
           WHERE um.company_id = c.company_id
             AND um.conversation_driver_id = c.driver_id
             AND um.sender_type != 'admin'
             AND um.read_at IS NULL
             AND um.deleted_at IS NULL
         ) AS unreadCount
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
      unreadCount: number;
    }>;

  return c.json({
    conversations: rows.map((row) => ({
      driverId: row.driverId,
      driverName: row.driverDisplayName || row.driverUsername || "Driver",
      driverUsername: row.driverUsername,
      vehicleId: row.vehicleId || undefined,
      lastMessageAtMillis: row.lastMessageAtMillis,
      unreadCount: Number(row.unreadCount ?? 0),
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
      `SELECT ${MESSAGE_SELECT_COLUMNS}
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

companyRoutes.post("/route47/companies/:companyId/messages/conversations/:driverId/read", (c) => {
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

  const readAt = now();
  const result = db
    .prepare(
      `UPDATE messages
       SET read_at = ?
       WHERE company_id = ?
         AND conversation_driver_id = ?
         AND sender_type != 'admin'
         AND read_at IS NULL
         AND deleted_at IS NULL`,
    )
    .run(readAt, companyId, driverId);

  return c.json({
    message: "Conversation marked as read.",
    driverId,
    markedRead: result.changes,
    readAtMillis: readAt,
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
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as MessageRow;

  return c.json({ message: "Message sent.", sentMessage: messageToJson(row), createdAtMillis: createdAt }, 201);
});

async function handleEditMessage(c: Context<AuthEnv>) {
  const companyId = c.req.param("companyId") ?? "";
  const messageId = c.req.param("messageId")?.trim() ?? "";

  const message = messageId ? getMessage(companyId, messageId) : undefined;
  if (!message) {
    return c.json({ message: "Message not found." }, 404);
  }
  if (message.deleted_at != null) {
    return c.json({ message: "Message was deleted." }, 409);
  }

  const role = resolveMessageMutationRole(c, companyId, message);
  if (!role) {
    return c.json({ message: "You can only edit your own messages." }, 403);
  }

  const payload = await c.req.json<{ body?: string }>();
  const text = payload.body?.trim() ?? "";
  if (!text && !message.attachment_url) {
    return c.json({ message: "body is required." }, 400);
  }

  db.prepare(`UPDATE messages SET body = ?, edited_at = ? WHERE company_id = ? AND id = ?`).run(
    text,
    now(),
    companyId,
    messageId,
  );

  const updated = getMessage(companyId, messageId) as MessageRow;
  return c.json({ message: "Message updated.", updatedMessage: messageToJson(updated) });
}

companyRoutes.patch("/route47/companies/:companyId/messages/items/:messageId", handleEditMessage);
// Android's HttpURLConnection cannot send PATCH, so the Driver App uses PUT.
companyRoutes.put("/route47/companies/:companyId/messages/items/:messageId", handleEditMessage);

companyRoutes.delete("/route47/companies/:companyId/messages/items/:messageId", (c) => {
  const companyId = c.req.param("companyId");
  const messageId = c.req.param("messageId")?.trim() ?? "";

  const message = messageId ? getMessage(companyId, messageId) : undefined;
  if (!message) {
    return c.json({ message: "Message not found." }, 404);
  }
  if (message.deleted_at != null) {
    return c.json({ message: "Message already deleted.", deletedMessage: messageToJson(message) });
  }

  const role = resolveMessageMutationRole(c, companyId, message);
  if (!role) {
    return c.json({ message: "You can only delete your own messages." }, 403);
  }

  if (message.attachment_url) {
    deleteAttachmentFileForUrl(companyId, message.attachment_url);
  }

  db.prepare(
    `UPDATE messages
     SET deleted_at = ?, body = '', attachment_url = '', mime_type = ''
     WHERE company_id = ? AND id = ?`,
  ).run(now(), companyId, messageId);

  const updated = getMessage(companyId, messageId) as MessageRow;
  return c.json({ message: "Message deleted.", deletedMessage: messageToJson(updated) });
});

companyRoutes.post("/route47/companies/:companyId/messages/attachments", async (c) => {
  const companyId = c.req.param("companyId");
  const isAdmin = hasAdminAccess(c);
  const driverId = c.get("driverId")?.trim() ?? "";

  if (!isAdmin && !driverId) {
    return c.json({ message: "Authentication required." }, 401);
  }

  const body = await c.req.parseBody({ all: true });
  const fields = body as Record<string, string | File | (string | File)[]>;
  const fileEntry = fields.file;
  const file = Array.isArray(fileEntry) ? fileEntry[0] : fileEntry;

  if (!(file instanceof File)) {
    return c.json({ message: "Attachment file is required." }, 400);
  }

  const maxBytes = 25 * 1024 * 1024;
  if (file.size > maxBytes) {
    return c.json({ message: "Attachment too large (max 25 MB)." }, 413);
  }

  const attachmentId = rid("msgatt");
  const safeName = (file.name || "attachment.bin").replace(/[^\w.\- ]+/g, "_").slice(0, 120);

  // Attachments live in the owning branch's Messages/ folder. Driver uploads go
  // to the driver's branch; admin uploads go to the admin's first assigned
  // branch (or the company default when unrestricted).
  let branchId: string;
  if (!isAdmin && driverId) {
    branchId = getDriverBranchId(companyId, driverId);
  } else {
    const admin = c.get("admin");
    branchId = admin
      ? getAdminDefaultBranchId(companyId, admin.id)
      : defaultBranchId(companyId);
  }

  const storedDir = path.join(ensureBranchOperationalLayout(companyId, branchId), "Messages");
  const storedPath = path.join(storedDir, `${attachmentId}-${safeName}`);

  fs.mkdirSync(storedDir, { recursive: true });
  fs.writeFileSync(storedPath, Buffer.from(await file.arrayBuffer()));

  const mimeType = file.type || "application/octet-stream";

  db.prepare(
    `INSERT INTO message_attachments (id, company_id, uploader_type, file_name, file_path, mime_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attachmentId,
    companyId,
    isAdmin ? "admin" : "driver",
    safeName,
    storedPath,
    mimeType,
    now(),
  );

  return c.json(
    {
      message: "Attachment uploaded.",
      attachmentId,
      attachmentUrl: `/route47/companies/${companyId}/messages/attachments/${attachmentId}/file`,
      fileName: safeName,
      mimeType,
    },
    201,
  );
});

companyRoutes.get("/route47/companies/:companyId/messages/attachments/:attachmentId/file", (c) => {
  const companyId = c.req.param("companyId");
  const attachmentId = c.req.param("attachmentId")?.trim() ?? "";

  const isAdmin = hasAdminAccess(c);
  const driverId = c.get("driverId")?.trim() ?? "";
  if (!isAdmin && !driverId) {
    return c.json({ message: "Authentication required." }, 401);
  }

  const row = db
    .prepare(
      `SELECT file_name, file_path, mime_type FROM message_attachments WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, attachmentId) as
    | { file_name: string; file_path: string; mime_type: string }
    | undefined;

  if (!row || !fs.existsSync(row.file_path)) {
    return c.json({ message: "Attachment not found." }, 404);
  }

  const data = fs.readFileSync(row.file_path);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": row.mime_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${row.file_name}"`,
    },
  });
});
