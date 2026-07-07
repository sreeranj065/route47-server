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
  invite_code: string | null;
  invited_by: string | null;
  status: "invited" | "active" | "disabled";
  disabled_at: number | null;
  created_at: number;
  redeemed_at: number | null;
}

export interface BranchRow {
  id: string;
  company_id: string;
  name: string;
  address: string;
  is_primary: number;
  created_at: number;
}

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
       WHERE company_id = ? AND api_key = ? AND status = 'active' AND disabled_at IS NULL`,
    )
    .get(companyId, value) as AdminRow | undefined;

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
    `INSERT INTO company_branches (id, company_id, name, address, is_primary, created_at)
     VALUES (?, ?, 'Head Office', '', 1, ?)`,
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
  db.prepare(`DELETE FROM admin_branch_access WHERE company_id = ? AND admin_id = ?`).run(
    companyId,
    adminId,
  );

  const validIds = new Set(listCompanyBranches(companyId).map((b) => b.id));
  const insert = db.prepare(
    `INSERT INTO admin_branch_access (company_id, admin_id, branch_id, created_at) VALUES (?, ?, ?, ?)`,
  );
  const now = Date.now();

  for (const branchId of branchIds) {
    if (!validIds.has(branchId)) continue;
    insert.run(companyId, adminId, branchId, now);
  }
}

export function branchToJson(row: BranchRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    address: row.address,
    isPrimary: row.is_primary === 1,
    createdAtMillis: row.created_at,
  };
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
