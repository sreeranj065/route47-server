import type { AdminIdentity } from "./admin-auth.js";
import { db } from "../db.js";
import { ensureDefaultBranch, getAdminBranchIds } from "./admin-auth.js";

export function ensureDriverBranchColumn() {
  const columns = db
    .prepare(`PRAGMA table_info(drivers)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "branch_id")) {
    db.exec(`ALTER TABLE drivers ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''`);
  }
}

export function defaultBranchId(companyId: string): string {
  return ensureDefaultBranch(companyId).id;
}

export function resolveDriverBranchId(companyId: string, branchId?: string | null): string {
  const trimmed = branchId?.trim() ?? "";
  if (!trimmed) return defaultBranchId(companyId);
  const row = db
    .prepare(`SELECT id FROM company_branches WHERE company_id = ? AND id = ?`)
    .get(companyId, trimmed) as { id?: string } | undefined;
  return row?.id ?? defaultBranchId(companyId);
}

/** null = unrestricted (owner / legacy owner key). */
export function getAdminAllowedBranchIds(
  companyId: string,
  admin: AdminIdentity | null | undefined,
): string[] | null {
  if (!admin || admin.id === "owner" || admin.role === "owner") return null;
  return getAdminBranchIds(companyId, admin.id);
}

export function adminCanAccessBranch(
  companyId: string,
  admin: AdminIdentity | null | undefined,
  branchId: string,
): boolean {
  const allowed = getAdminAllowedBranchIds(companyId, admin);
  if (allowed === null) return true;
  if (!branchId) return true;
  return allowed.includes(branchId);
}

export function adminCanAccessDriver(
  companyId: string,
  admin: AdminIdentity | null | undefined,
  driverId: string,
): boolean {
  const allowed = getAdminAllowedBranchIds(companyId, admin);
  if (allowed === null) return true;

  const row = db
    .prepare(`SELECT branch_id AS branchId FROM drivers WHERE company_id = ? AND id = ?`)
    .get(companyId, driverId) as { branchId?: string } | undefined;
  if (!row) return false;

  const branchId = row.branchId?.trim() || defaultBranchId(companyId);
  return allowed.includes(branchId);
}

export function listAccessibleDriverIds(
  companyId: string,
  admin: AdminIdentity | null | undefined,
): string[] | null {
  const allowedBranches = getAdminAllowedBranchIds(companyId, admin);
  if (allowedBranches === null) return null;

  const rows = db
    .prepare(`SELECT id, branch_id AS branchId FROM drivers WHERE company_id = ?`)
    .all(companyId) as Array<{ id: string; branchId?: string }>;

  const defaultBranch = defaultBranchId(companyId);
  return rows
    .filter((row) => allowedBranches.includes(row.branchId?.trim() || defaultBranch))
    .map((row) => row.id);
}

export function driverBranchFilterSql(
  companyId: string,
  admin: AdminIdentity | null | undefined,
  driverIdColumn = "driver_id",
): { clause: string; params: unknown[] } {
  const allowedBranches = getAdminAllowedBranchIds(companyId, admin);
  if (allowedBranches === null) {
    return { clause: "", params: [] };
  }

  const defaultBranch = defaultBranchId(companyId);
  const placeholders = allowedBranches.map(() => "?").join(", ");
  return {
    clause: ` AND (
      ${driverIdColumn} IN (
        SELECT id FROM drivers
        WHERE company_id = ?
          AND COALESCE(NULLIF(branch_id, ''), ?) IN (${placeholders})
      )
    )`,
    params: [companyId, defaultBranch, ...allowedBranches],
  };
}

ensureDriverBranchColumn();
