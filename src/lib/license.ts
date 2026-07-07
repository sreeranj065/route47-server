import { db } from "../db.js";

export type OrganizationLicenseRow = {
  company_id: string;
  plan: string;
  max_admin_users: number;
  max_drivers: number | null;
  status: string;
  updated_at: number;
};

const DEFAULT_MAX_ADMIN_USERS = 3;

export function ensureOrganizationLicense(companyId: string): OrganizationLicenseRow {
  const existing = db
    .prepare(`SELECT * FROM organization_licenses WHERE company_id = ?`)
    .get(companyId) as OrganizationLicenseRow | undefined;

  if (existing) return existing;

  const now = Date.now();
  db.prepare(
    `INSERT INTO organization_licenses (company_id, plan, max_admin_users, max_drivers, status, updated_at)
     VALUES (?, 'standard', ?, NULL, 'active', ?)`,
  ).run(companyId, DEFAULT_MAX_ADMIN_USERS, now);

  return db
    .prepare(`SELECT * FROM organization_licenses WHERE company_id = ?`)
    .get(companyId) as OrganizationLicenseRow;
}

export function getMaxAdminUsers(companyId: string): number {
  const license = ensureOrganizationLicense(companyId);
  return Math.max(1, license.max_admin_users ?? DEFAULT_MAX_ADMIN_USERS);
}

/** Counts implicit owner + invited/active teammates (disabled users excluded). */
export function countLicensedAdminSeats(companyId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM admins
       WHERE company_id = ? AND status IN ('invited', 'active') AND disabled_at IS NULL`,
    )
    .get(companyId) as { c: number };
  return row.c + 1;
}

export function canInviteAnotherAdmin(companyId: string): { allowed: boolean; limit: number; used: number } {
  const limit = getMaxAdminUsers(companyId);
  const used = countLicensedAdminSeats(companyId);
  return { allowed: used < limit, limit, used };
}

export function licenseToJson(row: OrganizationLicenseRow) {
  return {
    companyId: row.company_id,
    plan: row.plan,
    maxAdminUsers: row.max_admin_users,
    maxDrivers: row.max_drivers,
    status: row.status,
    usedAdminUsers: countLicensedAdminSeats(row.company_id),
    updatedAtMillis: row.updated_at,
  };
}
