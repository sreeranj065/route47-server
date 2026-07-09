import fs from "node:fs";
import path from "node:path";
import { db, MESSAGE_ATTACHMENTS_DIR } from "./db.js";
import { ensureBranchOperationalLayout, getDriverBranchId } from "./branch-storage.js";
import { defaultBranchId } from "./lib/branch-filter.js";

type AttachmentRow = {
  id: string;
  company_id: string;
  file_name: string;
  file_path: string;
};

/**
 * Resolves the branch that owns a message attachment by following the message
 * that references it back to the conversation's driver.
 */
function attachmentBranchId(companyId: string, attachmentId: string): string {
  const row = db
    .prepare(
      `SELECT conversation_driver_id AS driverId FROM messages
       WHERE company_id = ? AND attachment_url LIKE ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(companyId, `%/messages/attachments/${attachmentId}/file`) as
    | { driverId?: string }
    | undefined;

  if (row?.driverId?.trim()) {
    return getDriverBranchId(companyId, row.driverId);
  }
  return defaultBranchId(companyId);
}

/** Moves legacy `{DATA_DIR}/message-attachments/{companyId}/...` files into each branch's Messages/ folder. */
export function migrateMessageAttachmentPaths(): number {
  const rows = db
    .prepare(`SELECT id, company_id, file_name, file_path FROM message_attachments`)
    .all() as AttachmentRow[];

  let migrated = 0;

  for (const row of rows) {
    if (!row.file_path || !fs.existsSync(row.file_path)) continue;

    // Only move files still living under the legacy layout.
    const relative = path.relative(MESSAGE_ATTACHMENTS_DIR, row.file_path);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;

    const branchId = attachmentBranchId(row.company_id, row.id);
    const branchRoot = ensureBranchOperationalLayout(row.company_id, branchId);
    const storedName = path.basename(row.file_path);
    const storedPath = path.join(branchRoot, "Messages", storedName);

    if (storedPath === row.file_path) continue;

    fs.mkdirSync(path.dirname(storedPath), { recursive: true });

    try {
      fs.renameSync(row.file_path, storedPath);
    } catch {
      fs.copyFileSync(row.file_path, storedPath);
      try {
        fs.unlinkSync(row.file_path);
      } catch {
        // Keep going — DB will point at the new path.
      }
    }

    db.prepare(`UPDATE message_attachments SET file_path = ? WHERE id = ?`).run(storedPath, row.id);
    migrated += 1;
  }

  return migrated;
}
