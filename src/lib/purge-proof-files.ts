/**
 * Deletes POD / Pickup / Receipt proof files + DB rows for a branch.
 * Keeps drivers, geofences, team, licenses, routes, trips, messages, company data.
 */
import fs from "node:fs";
import path from "node:path";
import { db, PROOFS_DIR } from "../db.js";
import {
  ensureBranchOperationalLayout,
  getBranchOperationalRoot,
} from "../branch-storage.js";
import { createBranchBackup } from "./branch-backup.js";

const PURGE_FOLDERS = ["PODs", "Pickups", "Receipts"] as const;

function rmRecursive(target: string) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function clearFolderContents(folder: string) {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(folder)) {
    rmRecursive(path.join(folder, entry));
  }
}

export function purgeBranchProofFiles(options: {
  companyId: string;
  branchId: string;
}): {
  backupId: string;
  deletedProofRows: number;
  clearedFolders: string[];
} {
  const { companyId, branchId } = options;

  // Mandatory backup before any delete.
  const backup = createBranchBackup({
    companyId,
    branchId,
    trigger: "pre-purge",
    note: "Automatic backup before deleting proof files",
  });

  ensureBranchOperationalLayout(companyId, branchId);
  const root = getBranchOperationalRoot(companyId, branchId);
  const clearedFolders: string[] = [];
  for (const name of PURGE_FOLDERS) {
    const folder = path.join(root, name);
    clearFolderContents(folder);
    clearedFolders.push(name);
  }

  // Legacy flat proofs dir for this company (best-effort; may include other branches).
  const legacyCompanyProofs = path.join(PROOFS_DIR, companyId);
  if (fs.existsSync(legacyCompanyProofs)) {
    // Only remove files that belong to this branch when branch_id is known in DB.
    const rows = db
      .prepare(
        `SELECT file_path AS filePath FROM proofs
         WHERE company_id = ? AND (
           branch_id = ?
           OR (IFNULL(branch_id, '') = '' AND driver_id IN (
             SELECT id FROM drivers WHERE company_id = ? AND branch_id = ?
           ))
         )`,
      )
      .all(companyId, branchId, companyId, branchId) as Array<{ filePath?: string }>;
    for (const row of rows) {
      const filePath = row.filePath?.trim();
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const result = db
    .prepare(
      `DELETE FROM proofs WHERE company_id = ? AND (
         branch_id = ?
         OR (IFNULL(branch_id, '') = '' AND driver_id IN (
           SELECT id FROM drivers WHERE company_id = ? AND branch_id = ?
         ))
       )`,
    )
    .run(companyId, branchId, companyId, branchId);

  return {
    backupId: backup.id,
    deletedProofRows: Number(result.changes ?? 0),
    clearedFolders,
  };
}
