import { Hono } from "hono";
import { db, getCompany } from "../db.js";
import {
  adminToJson,
  branchToJson,
  countActiveOwners,
  ensureDefaultBranch,
  getAdminBranchIds,
  getAdminDefaultBranchId,
  hashAdminKey,
  listCompanyBranches,
  readAdminKeyFromHeaders,
  requireAdminRole,
  resolveAdminIdentity,
  setAdminBranchIds,
  setAdminDefaultBranchId,
  syncPrimaryBranchFromCompanyProfile,
  type AdminIdentity,
  type AdminRow,
} from "../lib/admin-auth.js";
import { adminCanAccessBranch, getAdminAllowedBranchIds } from "../lib/branch-filter.js";
import { buildBranchStorageLayout } from "../branch-storage.js";
import { buildStorageMetrics } from "../lib/storage-metrics.js";
import { canInviteAnotherAdmin, ensureOrganizationLicense, licenseToJson } from "../lib/license.js";
import { inviteCode, now, optionalString, rid, stringOr } from "../lib/util.js";
import { companyRoutes } from "./auth.js";

const VALID_ROLES = ["owner", "admin", "dispatcher", "viewer"] as const;
type AdminRole = (typeof VALID_ROLES)[number];

function isValidRole(value: string): value is AdminRole {
  return (VALID_ROLES as readonly string[]).includes(value);
}

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }): AdminIdentity | null {
  return c.get("admin") ?? null;
}

function requireAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  const admin = getAdmin(c);
  if (!admin) return { ok: false as const, admin: null };
  return { ok: true as const, admin };
}

companyRoutes.get("/route47/companies/:companyId/admin/team", (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);
  if (!company) return c.json({ message: "Company not found." }, 404);

  const rows = db
    .prepare(`SELECT * FROM admins WHERE company_id = ? ORDER BY created_at`)
    .all(companyId) as unknown as AdminRow[];

  const owner = {
    id: "owner",
    name: `${company.name} (Owner)`,
    email: "",
    role: "owner" as const,
    status: "active" as const,
    inviteCode: undefined,
    branchIds: getAdminBranchIds(companyId, "owner"),
    createdAtMillis: company.createdAt,
    redeemedAtMillis: company.createdAt,
    isImplicitOwner: true,
  };

  return c.json({
    admins: [owner, ...rows.map((row) => adminToJson(row))],
    license: licenseToJson(ensureOrganizationLicense(companyId)),
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/team", async (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(auth.admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can invite teammates." }, 403);
  }

  const companyId = c.req.param("companyId");
  const seatCheck = canInviteAnotherAdmin(companyId);
  if (!seatCheck.allowed) {
    return c.json(
      {
        message: `Licensed admin user limit reached (${seatCheck.used}/${seatCheck.limit}). Remove a user or upgrade your subscription.`,
        limit: seatCheck.limit,
        used: seatCheck.used,
      },
      409,
    );
  }

  const body = await c.req.json<{ name?: string; email?: string; role?: string; branchIds?: string[] }>();
  const name = stringOr(body.name).trim();
  const email = stringOr(body.email).trim();
  const roleInput = stringOr(body.role, "dispatcher").trim();

  if (!name || !email) {
    return c.json({ message: "name and email are required" }, 400);
  }
  if (!isValidRole(roleInput)) {
    return c.json({ message: `role must be one of: ${VALID_ROLES.join(", ")}` }, 400);
  }
  if (roleInput === "owner" && auth.admin.role !== "owner") {
    return c.json({ message: "Only an owner can invite another owner" }, 403);
  }

  const id = rid("teamadmin");
  const code = inviteCode();
  const ts = now();

  db.prepare(
    `INSERT INTO admins (id, company_id, name, email, role, invite_code, invited_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', ?)`,
  ).run(id, companyId, name, email, roleInput, code, auth.admin.id, ts);

  if (Array.isArray(body.branchIds) && body.branchIds.length > 0) {
    setAdminBranchIds(companyId, id, body.branchIds);
  } else {
    setAdminBranchIds(companyId, id, [ensureDefaultBranch(companyId).id]);
  }

  const admin = db.prepare(`SELECT * FROM admins WHERE id = ?`).get(id) as unknown as AdminRow;
  return c.json(adminToJson(admin));
});

companyRoutes.patch("/route47/companies/:companyId/admin/team/:adminId", async (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(auth.admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can edit teammates." }, 403);
  }

  const companyId = c.req.param("companyId");
  const adminId = c.req.param("adminId");
  const admin = db
    .prepare(`SELECT * FROM admins WHERE company_id = ? AND id = ?`)
    .get(companyId, adminId) as unknown as AdminRow | undefined;

  if (!admin) return c.json({ message: "Team member not found" }, 404);

  const body = await c.req.json<{
    role?: string;
    name?: string;
    branchIds?: string[];
    disabled?: boolean;
    resendInvite?: boolean;
  }>();

  if (body.resendInvite) {
    if (admin.status !== "invited") {
      return c.json({ message: "Only pending invites can be resent." }, 409);
    }
    const code = inviteCode();
    db.prepare(`UPDATE admins SET invite_code = ? WHERE id = ?`).run(code, admin.id);
    const updated = db.prepare(`SELECT * FROM admins WHERE id = ?`).get(admin.id) as unknown as AdminRow;
    return c.json(adminToJson(updated));
  }

  const nextRoleInput = optionalString(body.role);
  const nextName = optionalString(body.name);

  if (nextRoleInput !== undefined) {
    if (!isValidRole(nextRoleInput)) {
      return c.json({ message: `role must be one of: ${VALID_ROLES.join(", ")}` }, 400);
    }
    if ((nextRoleInput === "owner" || admin.role === "owner") && auth.admin.role !== "owner") {
      return c.json({ message: "Only an owner can grant or revoke the owner role" }, 403);
    }
    if (admin.role === "owner" && nextRoleInput !== "owner" && countActiveOwners(companyId) <= 1) {
      return c.json({ message: "Cannot remove the last owner" }, 409);
    }
  }

  if (body.disabled === true && admin.role === "owner" && countActiveOwners(companyId) <= 1) {
    return c.json({ message: "Cannot disable the last owner" }, 409);
  }

  const disabledAt =
    body.disabled === true ? now() : body.disabled === false ? null : admin.disabled_at;
  const nextStatus =
    body.disabled === true ? "disabled" : body.disabled === false ? "active" : admin.status;

  db.prepare(
    `UPDATE admins
     SET role = COALESCE(?, role),
         name = COALESCE(?, name),
         disabled_at = ?,
         status = ?
     WHERE id = ?`,
  ).run(nextRoleInput ?? null, nextName ?? null, disabledAt, nextStatus, admin.id);

  if (Array.isArray(body.branchIds)) {
    setAdminBranchIds(companyId, admin.id, body.branchIds);
  }

  const updated = db.prepare(`SELECT * FROM admins WHERE id = ?`).get(admin.id) as unknown as AdminRow;
  return c.json(adminToJson(updated));
});

companyRoutes.delete("/route47/companies/:companyId/admin/team/:adminId", (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(auth.admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can remove teammates." }, 403);
  }

  const companyId = c.req.param("companyId");
  const adminId = c.req.param("adminId");
  const admin = db
    .prepare(`SELECT * FROM admins WHERE company_id = ? AND id = ?`)
    .get(companyId, adminId) as unknown as AdminRow | undefined;

  if (!admin) return c.json({ message: "Team member not found" }, 404);
  if (admin.role === "owner" && auth.admin.role !== "owner") {
    return c.json({ message: "Only an owner can remove another owner" }, 403);
  }
  if (admin.role === "owner" && admin.status === "active" && countActiveOwners(companyId) <= 1) {
    return c.json({ message: "Cannot remove the last owner" }, 409);
  }

  db.prepare(`DELETE FROM admin_branch_access WHERE company_id = ? AND admin_id = ?`).run(
    companyId,
    admin.id,
  );
  db.prepare(`DELETE FROM admins WHERE id = ?`).run(admin.id);
  db.prepare(
    `DELETE FROM push_tokens WHERE company_id = ? AND recipient_type = 'admin' AND recipient_id = ?`,
  ).run(companyId, admin.id);

  return c.json({ message: "Team member removed", id: admin.id });
});

companyRoutes.get("/route47/companies/:companyId/admin/team/me", (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);
  if (!company) return c.json({ message: "Company not found." }, 404);

  return c.json({
    id: auth.admin.id,
    name: auth.admin.name,
    role: auth.admin.role,
    companyId,
    companyName: company.name,
    branchIds: getAdminBranchIds(companyId, auth.admin.id),
    defaultBranchId: getAdminDefaultBranchId(companyId, auth.admin.id),
    license: licenseToJson(ensureOrganizationLicense(companyId)),
  });
});

companyRoutes.patch("/route47/companies/:companyId/admin/team/me", async (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{ defaultBranchId?: string }>();
  const branchId = body.defaultBranchId?.trim() ?? "";
  if (!branchId) return c.json({ message: "defaultBranchId is required" }, 400);

  const result = setAdminDefaultBranchId(companyId, auth.admin.id, branchId);
  if (!result.ok) return c.json({ message: result.message }, 400);

  return c.json({
    defaultBranchId: getAdminDefaultBranchId(companyId, auth.admin.id),
    message: "Default branch updated.",
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/branches", (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  const allowed = getAdminAllowedBranchIds(companyId, auth.admin);
  const branches = listCompanyBranches(companyId)
    .filter((row) => allowed === null || allowed.includes(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      isPrimary: row.is_primary === 1,
      isDefaultForMe: row.id === getAdminDefaultBranchId(companyId, auth.admin.id),
    }));

  return c.json({ branches });
});

companyRoutes.get("/route47/companies/:companyId/admin/storage-layout", (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  const allowed = getAdminAllowedBranchIds(companyId, auth.admin);
  const branchIds =
    allowed === null
      ? listCompanyBranches(companyId).map((row) => row.id)
      : allowed;

  return c.json({
    message: "Branch storage layout ready.",
    layout: buildBranchStorageLayout(companyId, branchIds),
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/storage-metrics", (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const allowed = getAdminAllowedBranchIds(companyId, auth.admin);
  const branchIds =
    allowed === null
      ? listCompanyBranches(companyId).map((row) => row.id)
      : allowed;

  return c.json({
    message: "Storage metrics ready.",
    metrics: buildStorageMetrics(companyId, branchIds),
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/branches", async (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(auth.admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can manage branches." }, 403);
  }

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{
    name?: string;
    address?: string;
    latitude?: number | null;
    longitude?: number | null;
    isPrimary?: boolean;
  }>();
  const name = body.name?.trim() ?? "";
  if (!name) return c.json({ message: "name is required" }, 400);

  const id = rid("branch");
  const ts = now();
  if (body.isPrimary) {
    db.prepare(`UPDATE company_branches SET is_primary = 0 WHERE company_id = ?`).run(companyId);
  }

  db.prepare(
    `INSERT INTO company_branches (id, company_id, name, address, latitude, longitude, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    companyId,
    name,
    body.address?.trim() ?? "",
    body.latitude ?? null,
    body.longitude ?? null,
    body.isPrimary ? 1 : 0,
    ts,
  );

  const row = db.prepare(`SELECT * FROM company_branches WHERE id = ?`).get(id) as unknown as import("../lib/admin-auth.js").BranchRow;
  return c.json(branchToJson(row));
});

companyRoutes.patch("/route47/companies/:companyId/admin/branches/:branchId", async (c) => {
  const auth = requireAdmin(c);
  if (!auth.ok) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(auth.admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can manage branches." }, 403);
  }

  const companyId = c.req.param("companyId");
  const branchId = c.req.param("branchId");
  if (!adminCanAccessBranch(companyId, auth.admin, branchId)) {
    return c.json({ message: "Branch not found." }, 404);
  }

  const body = await c.req.json<{
    name?: string;
    address?: string;
    latitude?: number | null;
    longitude?: number | null;
    isPrimary?: boolean;
  }>();
  if (body.isPrimary) {
    db.prepare(`UPDATE company_branches SET is_primary = 0 WHERE company_id = ?`).run(companyId);
  }

  db.prepare(
    `UPDATE company_branches
     SET name = COALESCE(?, name),
         address = COALESCE(?, address),
         latitude = CASE WHEN ? IS NULL THEN latitude ELSE ? END,
         longitude = CASE WHEN ? IS NULL THEN longitude ELSE ? END,
         is_primary = CASE WHEN ? IS NULL THEN is_primary ELSE ? END
     WHERE company_id = ? AND id = ?`,
  ).run(
    optionalString(body.name) ?? null,
    body.address !== undefined ? body.address.trim() : null,
    body.latitude === undefined ? null : 1,
    body.latitude ?? null,
    body.longitude === undefined ? null : 1,
    body.longitude ?? null,
    body.isPrimary === undefined ? null : body.isPrimary ? 1 : 0,
    body.isPrimary ? 1 : 0,
    companyId,
    branchId,
  );

  const row = db
    .prepare(`SELECT * FROM company_branches WHERE company_id = ? AND id = ?`)
    .get(companyId, branchId) as unknown as import("../lib/admin-auth.js").BranchRow | undefined;
  if (!row) return c.json({ message: "Branch not found." }, 404);
  return c.json(branchToJson(row));
});

export const adminInviteRoutes = new Hono();

adminInviteRoutes.post("/route47/admin-invites/redeem", async (c) => {
  const body = await c.req.json<{ inviteCode?: string; idToken?: string }>();
  const code = stringOr(body.inviteCode).trim();
  if (!code) return c.json({ message: "inviteCode is required" }, 400);

  const admin = db.prepare(`SELECT * FROM admins WHERE invite_code = ?`).get(code) as unknown as
    | AdminRow
    | undefined;
  if (!admin) return c.json({ message: "Invite code not found" }, 404);
  if (admin.status === "active") return c.json({ message: "Invite code already redeemed" }, 409);
  if (admin.status === "disabled") return c.json({ message: "This invite has been disabled." }, 403);

  const seatCheck = canInviteAnotherAdmin(admin.company_id);
  if (!seatCheck.allowed) {
    return c.json(
      {
        message: `Licensed admin user limit reached (${seatCheck.limit}). Ask your organization owner to remove a user or upgrade.`,
        limit: seatCheck.limit,
        used: seatCheck.used,
      },
      409,
    );
  }

  const company = getCompany(admin.company_id);
  if (!company) return c.json({ message: "Company for this invite no longer exists" }, 404);

  const apiKey = `team_${rid("key")}`;
  // Only the SHA-256 hash is stored — the plaintext key is returned to the
  // redeeming device once and never persisted server-side.
  db.prepare(
    `UPDATE admins SET api_key = NULL, api_key_hash = ?, status = 'active', redeemed_at = ?, disabled_at = NULL WHERE id = ?`,
  ).run(hashAdminKey(apiKey), now(), admin.id);

  // Best-effort: link Firebase for invitee reconnect when Admin sends idToken.
  let firebaseBound = false;
  if (body.idToken?.trim()) {
    const { bindAdminAccount } = await import("../lib/admin-reconnect.js");
    const bound = await bindAdminAccount({
      companyId: company.id,
      adminId: admin.id,
      idToken: body.idToken.trim(),
    });
    firebaseBound = bound.ok;
  }

  return c.json({
    message: "Invite redeemed.",
    apiKey,
    companyId: company.id,
    companyName: company.name,
    adminId: admin.id,
    name: admin.name,
    role: admin.role,
    branchIds: getAdminBranchIds(company.id, admin.id),
    defaultBranchId: getAdminDefaultBranchId(company.id, admin.id),
    firebaseBound,
  });
});

export function resolveAdminFromRequest(
  companyId: string,
  authorization: string | undefined,
  adminKeyHeader: string | undefined,
): AdminIdentity | null {
  const candidate = readAdminKeyFromHeaders(authorization, adminKeyHeader);
  return resolveAdminIdentity(companyId, candidate);
}
