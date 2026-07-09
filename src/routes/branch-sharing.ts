import { db } from "../db.js";
import { getAdminIdentity } from "../lib/route-admin.js";
import { requireAdminRole, listCompanyBranches } from "../lib/admin-auth.js";
import {
  adminCanAccessBranch,
  defaultBranchId,
  getAdminAllowedBranchIds,
} from "../lib/branch-filter.js";
import { getDriverBranchId } from "../branch-storage.js";
import { now, rid } from "../lib/util.js";
import { companyRoutes } from "./auth.js";

export type ShareableResourceType = "geofence" | "route" | "document";

const SHAREABLE_TYPES: ShareableResourceType[] = ["geofence", "route", "document"];

type ShareRow = {
  id: string;
  company_id: string;
  source_branch_id: string;
  target_branch_id: string;
  resource_type: string;
  resource_id: string;
  shared_by_admin_id: string;
  created_at: number;
};

/**
 * Resolves the branch a resource currently belongs to, plus a display name.
 * Returns null when the resource does not exist for this company.
 */
function resolveResource(
  companyId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
): { sourceBranchId: string; name: string } | null {
  if (resourceType === "geofence") {
    const row = db
      .prepare(`SELECT name, branch_id AS branchId FROM geofences WHERE company_id = ? AND id = ?`)
      .get(companyId, resourceId) as { name?: string; branchId?: string } | undefined;
    if (!row) return null;
    return {
      sourceBranchId: row.branchId?.trim() || defaultBranchId(companyId),
      name: row.name?.trim() || resourceId,
    };
  }

  if (resourceType === "route") {
    const row = db
      .prepare(
        `SELECT driver_id AS driverId, route_date_iso AS routeDateIso
         FROM route_plans WHERE company_id = ? AND route_run_id = ?`,
      )
      .get(companyId, resourceId) as { driverId?: string; routeDateIso?: string } | undefined;
    if (!row) return null;
    const sourceBranchId = row.driverId?.trim()
      ? getDriverBranchId(companyId, row.driverId)
      : defaultBranchId(companyId);
    return {
      sourceBranchId,
      name: row.routeDateIso ? `Route ${row.routeDateIso}` : resourceId,
    };
  }

  const row = db
    .prepare(
      `SELECT file_name AS fileName, driver_id AS driverId, branch_id AS branchId
       FROM proofs WHERE company_id = ? AND proof_id = ?`,
    )
    .get(companyId, resourceId) as
    | { fileName?: string; driverId?: string; branchId?: string }
    | undefined;
  if (!row) return null;
  const sourceBranchId =
    row.branchId?.trim() ||
    (row.driverId?.trim() ? getDriverBranchId(companyId, row.driverId) : defaultBranchId(companyId));
  return { sourceBranchId, name: row.fileName?.trim() || resourceId };
}

function shareToJson(companyId: string, row: ShareRow) {
  const branches = listCompanyBranches(companyId);
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  const resource = SHAREABLE_TYPES.includes(row.resource_type as ShareableResourceType)
    ? resolveResource(companyId, row.resource_type as ShareableResourceType, row.resource_id)
    : null;

  return {
    id: row.id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceName: resource?.name ?? row.resource_id,
    sourceBranchId: row.source_branch_id,
    sourceBranchName: branchName(row.source_branch_id),
    targetBranchId: row.target_branch_id,
    targetBranchName: branchName(row.target_branch_id),
    sharedByAdminId: row.shared_by_admin_id,
    createdAtMillis: row.created_at,
  };
}

companyRoutes.get("/route47/companies/:companyId/admin/shared-resources", (c) => {
  const admin = getAdminIdentity(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  const allowed = getAdminAllowedBranchIds(companyId, admin);

  let rows: ShareRow[];
  if (allowed === null) {
    rows = db
      .prepare(
        `SELECT * FROM branch_shared_resources WHERE company_id = ? ORDER BY created_at DESC`,
      )
      .all(companyId) as ShareRow[];
  } else if (allowed.length === 0) {
    rows = [];
  } else {
    const placeholders = allowed.map(() => "?").join(", ");
    rows = db
      .prepare(
        `SELECT * FROM branch_shared_resources
         WHERE company_id = ?
           AND (source_branch_id IN (${placeholders}) OR target_branch_id IN (${placeholders}))
         ORDER BY created_at DESC`,
      )
      .all(companyId, ...allowed, ...allowed) as ShareRow[];
  }

  return c.json({
    message: `${rows.length} shared resource(s).`,
    shares: rows.map((row) => shareToJson(companyId, row)),
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/shared-resources", async (c) => {
  const admin = getAdminIdentity(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can share resources across branches." }, 403);
  }

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{
    resourceType?: string;
    resourceId?: string;
    targetBranchIds?: string[];
  }>();

  const resourceType = (body.resourceType?.trim() ?? "") as ShareableResourceType;
  const resourceId = body.resourceId?.trim() ?? "";
  const targetBranchIds = [...new Set((body.targetBranchIds ?? []).map((id) => id.trim()).filter(Boolean))];

  if (!SHAREABLE_TYPES.includes(resourceType)) {
    return c.json({ message: `resourceType must be one of: ${SHAREABLE_TYPES.join(", ")}.` }, 400);
  }
  if (!resourceId) return c.json({ message: "resourceId is required." }, 400);
  if (targetBranchIds.length === 0) {
    return c.json({ message: "targetBranchIds is required." }, 400);
  }

  const resource = resolveResource(companyId, resourceType, resourceId);
  if (!resource) {
    return c.json({ message: "Resource not found." }, 404);
  }

  if (!adminCanAccessBranch(companyId, admin, resource.sourceBranchId)) {
    return c.json({ message: "You do not have access to this resource's branch." }, 403);
  }

  const validBranchIds = new Set(listCompanyBranches(companyId).map((b) => b.id));
  const created: ShareRow[] = [];
  const ts = now();

  for (const targetBranchId of targetBranchIds) {
    if (!validBranchIds.has(targetBranchId)) continue;
    if (targetBranchId === resource.sourceBranchId) continue;

    const existing = db
      .prepare(
        `SELECT id FROM branch_shared_resources
         WHERE company_id = ? AND resource_type = ? AND resource_id = ? AND target_branch_id = ?`,
      )
      .get(companyId, resourceType, resourceId, targetBranchId) as { id?: string } | undefined;
    if (existing?.id) continue;

    const id = rid("share");
    db.prepare(
      `INSERT INTO branch_shared_resources (
        id, company_id, source_branch_id, target_branch_id, resource_type, resource_id,
        shared_by_admin_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, companyId, resource.sourceBranchId, targetBranchId, resourceType, resourceId, admin.id, ts);

    created.push(
      db.prepare(`SELECT * FROM branch_shared_resources WHERE id = ?`).get(id) as ShareRow,
    );
  }

  return c.json(
    {
      message: `${created.length} share(s) created.`,
      shares: created.map((row) => shareToJson(companyId, row)),
    },
    201,
  );
});

companyRoutes.delete("/route47/companies/:companyId/admin/shared-resources/:shareId", (c) => {
  const admin = getAdminIdentity(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can manage shared resources." }, 403);
  }

  const companyId = c.req.param("companyId");
  const shareId = c.req.param("shareId");

  const row = db
    .prepare(`SELECT * FROM branch_shared_resources WHERE company_id = ? AND id = ?`)
    .get(companyId, shareId) as ShareRow | undefined;

  if (!row) return c.json({ message: "Share not found." }, 404);

  if (
    !adminCanAccessBranch(companyId, admin, row.source_branch_id) &&
    !adminCanAccessBranch(companyId, admin, row.target_branch_id)
  ) {
    return c.json({ message: "You do not have access to this share." }, 403);
  }

  db.prepare(`DELETE FROM branch_shared_resources WHERE company_id = ? AND id = ?`).run(companyId, shareId);

  return c.json({ message: "Share removed.", id: shareId });
});
