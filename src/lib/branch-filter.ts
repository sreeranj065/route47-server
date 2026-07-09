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
): { clause: string; params: Array<string | number> } {
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

export function branchColumnFilterSql(
  companyId: string,
  admin: AdminIdentity | null | undefined,
  branchColumn = "branch_id",
): { clause: string; params: Array<string | number> } {
  const allowedBranches = getAdminAllowedBranchIds(companyId, admin);
  if (allowedBranches === null) {
    return { clause: "", params: [] };
  }

  const defaultBranch = defaultBranchId(companyId);
  const placeholders = allowedBranches.map(() => "?").join(", ");
  return {
    clause: ` AND COALESCE(NULLIF(${branchColumn}, ''), ?) IN (${placeholders})`,
    params: [defaultBranch, ...allowedBranches],
  };
}

/** IDs of a resource type explicitly shared TO any of the given branches. */
export function sharedResourceIds(
  companyId: string,
  resourceType: string,
  targetBranchIds: string[],
): string[] {
  if (targetBranchIds.length === 0) return [];
  const placeholders = targetBranchIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT resource_id AS resourceId FROM branch_shared_resources
       WHERE company_id = ? AND resource_type = ? AND target_branch_id IN (${placeholders})`,
    )
    .all(companyId, resourceType, ...targetBranchIds) as Array<{ resourceId: string }>;
  return rows.map((row) => row.resourceId);
}

export function filterRowsByAccessibleDrivers<T extends { driverId?: unknown }>(
  rows: T[],
  companyId: string,
  admin: AdminIdentity | null | undefined,
): T[] {
  const accessibleIds = listAccessibleDriverIds(companyId, admin);
  if (accessibleIds === null) return rows;
  const allowed = new Set(accessibleIds);
  return rows.filter((row) => allowed.has(String(row.driverId ?? "").trim()));
}

ensureDriverBranchColumn();

export function ensureBranchIsolationSchema() {
  const proofColumns = db
    .prepare(`PRAGMA table_info(proofs)`)
    .all() as Array<{ name: string }>;
  if (!proofColumns.some((column) => column.name === "branch_id")) {
    db.exec(`ALTER TABLE proofs ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''`);
  }

  const geofenceColumns = db
    .prepare(`PRAGMA table_info(geofences)`)
    .all() as Array<{ name: string }>;
  if (!geofenceColumns.some((column) => column.name === "branch_id")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!geofenceColumns.some((column) => column.name === "stop_id")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN stop_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!geofenceColumns.some((column) => column.name === "route_id")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN route_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!geofenceColumns.some((column) => column.name === "last_triggered_at_millis")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN last_triggered_at_millis INTEGER NOT NULL DEFAULT 0`);
  }

  const heartbeatColumns = db
    .prepare(`PRAGMA table_info(heartbeats)`)
    .all() as Array<{ name: string }>;
  if (!heartbeatColumns.some((column) => column.name === "speed_kmh")) {
    db.exec(`ALTER TABLE heartbeats ADD COLUMN speed_kmh REAL`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_shared_resources (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      source_branch_id TEXT NOT NULL,
      target_branch_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      shared_by_admin_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_branch_shared_resources_target
      ON branch_shared_resources (company_id, target_branch_id, resource_type);
  `);
}

ensureBranchIsolationSchema();
