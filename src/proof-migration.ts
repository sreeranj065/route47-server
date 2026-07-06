import fs from "node:fs";
import path from "node:path";
import { db, PROOFS_DIR } from "./db.js";
import { buildStoredProofPath } from "./proof-storage.js";

type ProofRow = {
  proof_id: string;
  company_id: string;
  route_run_id: string;
  proof_type: string;
  file_name: string;
  file_path: string;
};

function isFlatProofPath(companyId: string, filePath: string): boolean {
  if (!filePath) return false;
  const companyRoot = path.join(PROOFS_DIR, companyId);
  const relative = path.relative(companyRoot, filePath);
  if (!relative || relative.startsWith("..")) return false;
  return !relative.includes(path.sep);
}

/** Moves legacy flat `{companyId}/{proofId}.ext` files into folder hierarchy. */
export function migrateFlatProofPaths(): number {
  const rows = db
    .prepare(
      `SELECT proof_id, company_id, route_run_id, proof_type, file_name, file_path
       FROM proofs`,
    )
    .all() as ProofRow[];

  let migrated = 0;

  for (const row of rows) {
    if (!isFlatProofPath(row.company_id, row.file_path)) continue;
    if (!fs.existsSync(row.file_path)) continue;

    const { storedPath, storedName } = buildStoredProofPath({
      companyId: row.company_id,
      proofId: row.proof_id,
      proofType: row.proof_type,
      routeRunId: row.route_run_id,
      originalFileName: row.file_name || `${row.proof_id}${path.extname(row.file_path) || ".bin"}`,
    });

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

    db.prepare(
      `UPDATE proofs SET file_name = ?, file_path = ? WHERE proof_id = ?`,
    ).run(storedName, storedPath, row.proof_id);

    migrated += 1;
  }

  return migrated;
}
