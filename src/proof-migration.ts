import fs from "node:fs";
import path from "node:path";
import { db, PROOFS_DIR } from "./db.js";
import { getDriverBranchId } from "./branch-storage.js";
import { defaultBranchId } from "./lib/branch-filter.js";
import { buildStoredProofPath } from "./proof-storage.js";

type ProofRow = {
  proof_id: string;
  company_id: string;
  driver_id: string;
  route_run_id: string;
  proof_type: string;
  file_name: string;
  file_path: string;
  branch_id?: string;
};

function isLegacyProofPath(companyId: string, filePath: string): boolean {
  if (!filePath) return false;
  const companyRoot = path.join(PROOFS_DIR, companyId);
  const relative = path.relative(companyRoot, filePath);
  if (!relative || relative.startsWith("..")) return false;
  return true;
}

/** Moves legacy `{proofs}/{companyId}/...` files into branch-isolated layout. */
export function migrateFlatProofPaths(): number {
  const rows = db
    .prepare(
      `SELECT proof_id, company_id, driver_id, route_run_id, proof_type, file_name, file_path, branch_id
       FROM proofs`,
    )
    .all() as ProofRow[];

  let migrated = 0;

  for (const row of rows) {
    if (!row.file_path || !fs.existsSync(row.file_path)) continue;

    const branchId =
      row.branch_id?.trim() ||
      getDriverBranchId(row.company_id, row.driver_id) ||
      defaultBranchId(row.company_id);

    const { storedPath, storedName } = buildStoredProofPath({
      companyId: row.company_id,
      branchId,
      proofId: row.proof_id,
      proofType: row.proof_type,
      routeRunId: row.route_run_id,
      driverId: row.driver_id,
      originalFileName: row.file_name || `${row.proof_id}${path.extname(row.file_path) || ".bin"}`,
    });

    if (storedPath === row.file_path) continue;

    const needsMove = isLegacyProofPath(row.company_id, row.file_path) || row.file_path !== storedPath;
    if (!needsMove) continue;

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

    db.prepare(
      `UPDATE proofs SET file_name = ?, file_path = ?, branch_id = ? WHERE proof_id = ?`,
    ).run(storedName, storedPath, branchId, row.proof_id);

    migrated += 1;
  }

  return migrated;
}
