import fs from "node:fs";
import path from "node:path";
import { db, DATA_DIR, getCompany } from "./db.js";
import { defaultBranchId } from "./lib/branch-filter.js";
import { listCompanyBranches } from "./lib/admin-auth.js";
import { buildProofFolderName, sanitizePathSegment } from "./proof-storage.js";

/** Root for branch-isolated operational files on disk. */
export const OPERATIONAL_DIR = path.join(DATA_DIR, "operational");
fs.mkdirSync(OPERATIONAL_DIR, { recursive: true });

/** Branch folder names shown in Admin / server screens (Backups is sibling to Documents). */
export const BRANCH_OPERATIONAL_FOLDERS = [
  "PODs",
  "Receipts",
  "Pickups",
  "Geofence Data",
  "Drivers",
  "Messages",
  "Routes",
  "Documents",
  "Backups",
] as const;

export type BranchOperationalFolder = (typeof BRANCH_OPERATIONAL_FOLDERS)[number];

export function proofFolderToOperationalCategory(folder: string): BranchOperationalFolder {
  const normalized = folder.toUpperCase();
  if (normalized === "POD") return "PODs";
  if (normalized === "PICKUP") return "Pickups";
  if (normalized === "RECEIPTS") return "Receipts";
  return "Documents";
}

export function getBranchLabel(
  companyId: string,
  branchId: string,
): { companyName: string; branchName: string } {
  const company = getCompany(companyId);
  const branches = listCompanyBranches(companyId);
  const branch = branches.find((entry) => entry.id === branchId);
  return {
    companyName: sanitizePathSegment(company?.name ?? companyId, companyId),
    branchName: sanitizePathSegment(branch?.name ?? branchId, branchId),
  };
}

export function getBranchOperationalRoot(companyId: string, branchId: string): string {
  const { companyName, branchName } = getBranchLabel(companyId, branchId);
  return path.join(OPERATIONAL_DIR, companyName, branchName);
}

export function ensureBranchOperationalLayout(companyId: string, branchId: string): string {
  const root = getBranchOperationalRoot(companyId, branchId);
  for (const folder of BRANCH_OPERATIONAL_FOLDERS) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  }
  return root;
}

export function getDriverBranchId(companyId: string, driverId: string): string {
  const trimmed = driverId.trim();
  if (!trimmed) return defaultBranchId(companyId);

  const row = db
    .prepare(`SELECT branch_id AS branchId FROM drivers WHERE company_id = ? AND id = ?`)
    .get(companyId, trimmed) as { branchId?: string } | undefined;

  return row?.branchId?.trim() || defaultBranchId(companyId);
}

export function buildBranchStorageLayout(companyId: string, branchIds: string[]) {
  const company = getCompany(companyId);
  const companyName = company?.name ?? companyId;
  const branches = listCompanyBranches(companyId).filter((branch) => branchIds.includes(branch.id));

  return {
    companyId,
    companyName,
    rootPath: OPERATIONAL_DIR,
    branches: branches.map((branch) => ({
      branchId: branch.id,
      branchName: branch.name,
      isPrimary: branch.is_primary === 1,
      path: `${sanitizePathSegment(companyName, companyId)}/${sanitizePathSegment(branch.name, branch.id)}`,
      folders: [...BRANCH_OPERATIONAL_FOLDERS],
    })),
  };
}
