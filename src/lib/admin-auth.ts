import crypto from "node:crypto";
import { db, getCompany } from "../db.js";
import { getExpectedAdminApiKey } from "../auth.js";

export type AdminRole = "owner" | "admin" | "dispatcher" | "viewer";

export interface AdminIdentity {
  id: string;
  name: string;
  role: AdminRole;
}

export interface AdminRow {
  id: string;
  company_id: string;
  name: string;
  email: string;
  role: AdminRole;
  api_key: string | null;
  api_key_hash: string | null;
  invite_code: string | null;
  invited_by: string | null;
  status: "invited" | "active" | "disabled";
  disabled_at: number | null;
  created_at: number;
  redeemed_at: number | null;
  /** Linked Route47 Admin Firebase UID for invitee reconnect (nullable). */
  firebase_uid?: string | null;
}

/** SHA-256 hex digest — admin API keys are stored hashed at rest. */
export function hashAdminKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Adds the api_key_hash column and migrates any plaintext keys into it,
 * clearing the plaintext copy. Idempotent; runs at boot. Existing admin
 * sessions keep working because lookups hash the presented key.
 */
export function ensureHashedAdminKeys() {
  const columns = db.prepare(`PRAGMA table_info(admins)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "api_key_hash")) {
    db.exec(`ALTER TABLE admins ADD COLUMN api_key_hash TEXT`);
  }

  const plaintextRows = db
    .prepare(`SELECT id, api_key FROM admins WHERE api_key IS NOT NULL AND api_key != ''`)
    .all() as Array<{ id: string; api_key: string }>;

  for (const row of plaintextRows) {
    db.prepare(`UPDATE admins SET api_key_hash = ?, api_key = NULL WHERE id = ?`).run(
      hashAdminKey(row.api_key),
      row.id,
    );
  }
}

ensureHashedAdminKeys();

export interface BranchRow {
  id: string;
  company_id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  is_primary: number;
  created_at: number;
}

/** Per-admin default branch flag on admin_branch_access (Phase 5b). */
export function ensureAdminBranchDefaultSchema() {
  const accessColumns = db.prepare(`PRAGMA table_info(admin_branch_access)`).all() as Array<{ name: string }>;
  if (!accessColumns.some((column) => column.name === "is_default")) {
    db.exec(`ALTER TABLE admin_branch_access ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`);
  }

  const branchColumns = db.prepare(`PRAGMA table_info(company_branches)`).all() as Array<{ name: string }>;
  if (!branchColumns.some((column) => column.name === "latitude")) {
    db.exec(`ALTER TABLE company_branches ADD COLUMN latitude REAL`);
  }
  if (!branchColumns.some((column) => column.name === "longitude")) {
    db.exec(`ALTER TABLE company_branches ADD COLUMN longitude REAL`);
  }
}

ensureAdminBranchDefaultSchema();

export function resolveAdminIdentity(companyId: string, candidate: string | undefined): AdminIdentity | null {
  const value = candidate?.trim() ?? "";
  if (!value) return null;

  const expected = getExpectedAdminApiKey();
  if (expected && expected.length === value.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected))) {
        const company = getCompany(companyId);
        return {
          id: "owner",
          name: company ? `${company.name} (Owner)` : "Owner",
          role: "owner",
        };
      }
    } catch {
      // length mismatch handled above
    }
  }

  const admin = db
    .prepare(
      `SELECT * FROM admins
       WHERE company_id = ? AND api_key_hash = ? AND status = 'active' AND disabled_at IS NULL`,
    )
    .get(companyId, hashAdminKey(value)) as AdminRow | undefined;

  if (admin) {
    return { id: admin.id, name: admin.name, role: admin.role };
  }

  return null;
}

export function readAdminKeyFromHeaders(
  authorization: string | undefined,
  adminKeyHeader: string | undefined,
): string | undefined {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return adminKeyHeader?.trim() ?? bearer;
}

export function requireAdminRole(identity: AdminIdentity | null, ...roles: AdminRole[]): boolean {
  if (!identity) return false;
  return roles.includes(identity.role);
}

export function ensureDefaultBranch(companyId: string): BranchRow {
  const existing = db
    .prepare(`SELECT * FROM company_branches WHERE company_id = ? ORDER BY is_primary DESC, created_at LIMIT 1`)
    .get(companyId) as BranchRow | undefined;

  if (existing) return existing;

  const now = Date.now();
  const id = `branch_${companyId}_hq`;
  db.prepare(
    `INSERT INTO company_branches (id, company_id, name, address, latitude, longitude, is_primary, created_at)
     VALUES (?, ?, 'Head Office', '', NULL, NULL, 1, ?)`,
  ).run(id, companyId, now);

  return db.prepare(`SELECT * FROM company_branches WHERE id = ?`).get(id) as unknown as BranchRow;
}

export function listCompanyBranches(companyId: string): BranchRow[] {
  ensureDefaultBranch(companyId);
  return db
    .prepare(`SELECT * FROM company_branches WHERE company_id = ? ORDER BY is_primary DESC, name`)
    .all(companyId) as unknown as BranchRow[];
}

export function getAdminBranchIds(companyId: string, adminId: string): string[] {
  if (adminId === "owner") {
    return listCompanyBranches(companyId).map((b) => b.id);
  }

  const rows = db
    .prepare(`SELECT branch_id FROM admin_branch_access WHERE company_id = ? AND admin_id = ?`)
    .all(companyId, adminId) as Array<{ branch_id: string }>;

  if (rows.length === 0) {
    const defaultBranch = ensureDefaultBranch(companyId);
    return [defaultBranch.id];
  }

  return rows.map((r) => r.branch_id);
}

export function adminHasBranchAccess(companyId: string, adminId: string, branchId: string): boolean {
  if (!branchId) return true;
  if (adminId === "owner") return true;
  const allowed = getAdminBranchIds(companyId, adminId);
  return allowed.includes(branchId);
}

export function setAdminBranchIds(companyId: string, adminId: string, branchIds: string[]) {
  // Only reuse a previously marked default if this admin already has access rows.
  // Do NOT fall back to the company primary branch here — that made invited teammates
  // keep the main branch as base even when invited to another branch.
  const existingDefault = db
    .prepare(
      `SELECT branch_id AS branchId FROM admin_branch_access
       WHERE company_id = ? AND admin_id = ? AND is_default = 1
       LIMIT 1`,
    )
    .get(companyId, adminId) as { branchId?: string } | undefined;

  db.prepare(`DELETE FROM admin_branch_access WHERE company_id = ? AND admin_id = ?`).run(
    companyId,
    adminId,
  );

  const validIds = new Set(listCompanyBranches(companyId).map((b) => b.id));
  const insert = db.prepare(
    `INSERT INTO admin_branch_access (company_id, admin_id, branch_id, created_at, is_default)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  const previousDefault = existingDefault?.branchId;
  const nextDefault =
    previousDefault && branchIds.includes(previousDefault)
      ? previousDefault
      : branchIds.find((branchId) => validIds.has(branchId)) ?? null;

  for (const branchId of branchIds) {
    if (!validIds.has(branchId)) continue;
    insert.run(companyId, adminId, branchId, now, branchId === nextDefault ? 1 : 0);
  }
}

export function getAdminDefaultBranchId(companyId: string, adminId: string): string {
  const row = db
    .prepare(
      `SELECT branch_id AS branchId FROM admin_branch_access
       WHERE company_id = ? AND admin_id = ? AND is_default = 1
       LIMIT 1`,
    )
    .get(companyId, adminId) as { branchId?: string } | undefined;

  if (row?.branchId) return row.branchId;

  // Assigned branch without is_default flag — use first access row, not company primary.
  const firstAssigned = db
    .prepare(
      `SELECT branch_id AS branchId FROM admin_branch_access
       WHERE company_id = ? AND admin_id = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(companyId, adminId) as { branchId?: string } | undefined;
  if (firstAssigned?.branchId) return firstAssigned.branchId;

  return ensureDefaultBranch(companyId).id;
}

export function setAdminDefaultBranchId(
  companyId: string,
  adminId: string,
  branchId: string,
): { ok: true } | { ok: false; message: string } {
  const trimmed = branchId.trim();
  if (!trimmed) return { ok: false, message: "branchId is required" };

  const validIds = new Set(listCompanyBranches(companyId).map((b) => b.id));
  if (!validIds.has(trimmed)) return { ok: false, message: "Branch not found." };

  if (adminId !== "owner") {
    const allowed = getAdminBranchIds(companyId, adminId);
    if (!allowed.includes(trimmed)) {
      return { ok: false, message: "You do not have access to that branch." };
    }
  }

  db.prepare(`UPDATE admin_branch_access SET is_default = 0 WHERE company_id = ? AND admin_id = ?`).run(
    companyId,
    adminId,
  );

  const existing = db
    .prepare(
      `SELECT branch_id FROM admin_branch_access WHERE company_id = ? AND admin_id = ? AND branch_id = ?`,
    )
    .get(companyId, adminId, trimmed) as { branch_id?: string } | undefined;

  const now = Date.now();
  if (existing) {
    db.prepare(
      `UPDATE admin_branch_access SET is_default = 1 WHERE company_id = ? AND admin_id = ? AND branch_id = ?`,
    ).run(companyId, adminId, trimmed);
  } else {
    db.prepare(
      `INSERT INTO admin_branch_access (company_id, admin_id, branch_id, created_at, is_default)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(companyId, adminId, trimmed, now);
  }

  return { ok: true };
}

export function branchToJson(row: BranchRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    address: row.address,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    isPrimary: row.is_primary === 1,
    createdAtMillis: row.created_at,
  };
}

export function syncPrimaryBranchFromCompanyProfile(
  companyId: string,
  patch: { address?: string; latitude?: number | null; longitude?: number | null },
) {
  const primary = ensureDefaultBranch(companyId);
  const address = patch.address !== undefined ? patch.address.trim() : primary.address;
  const latitude = patch.latitude !== undefined ? patch.latitude : primary.latitude;
  const longitude = patch.longitude !== undefined ? patch.longitude : primary.longitude;

  db.prepare(
    `UPDATE company_branches
     SET address = ?, latitude = ?, longitude = ?
     WHERE company_id = ? AND id = ?`,
  ).run(address, latitude, longitude, companyId, primary.id);
}

export function adminToJson(admin: AdminRow, branchIds?: string[]) {
  const status =
    admin.disabled_at != null
      ? ("disabled" as const)
      : admin.status === "invited"
        ? ("invited" as const)
        : ("active" as const);

  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    status,
    inviteCode: status === "invited" ? admin.invite_code : undefined,
    branchIds: branchIds ?? getAdminBranchIds(admin.company_id, admin.id),
    createdAtMillis: admin.created_at,
    redeemedAtMillis: admin.redeemed_at ?? undefined,
    disabledAtMillis: admin.disabled_at ?? undefined,
  };
}

export function countActiveOwners(companyId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM admins WHERE company_id = ? AND role = 'owner' AND status = 'active' AND disabled_at IS NULL`,
    )
    .get(companyId) as { c: number };
  return row.c + 1;
}
