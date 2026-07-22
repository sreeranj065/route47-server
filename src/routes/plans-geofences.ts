import crypto from "node:crypto";
import { hasAdminAccess } from "../lib/route-admin.js";
import { companyRoutes } from "./auth.js";
import { db, geofenceToJson, getCompany, routePlanToJson, type GeofenceRow, type RoutePlanRow } from "../db.js";
import {
  notifyRoutePlanPublished,
  notifyDriverRoutePlanSynced,
  notifyGeofencesChanged,
} from "../lib/route-notification-hooks.js";
import {
  canonicalRouteRunId,
  deleteDuplicateRoutePlansForDriverDay,
} from "../lib/route-plan-sync.js";
import {
  branchColumnFilterSql,
  defaultBranchId,
  driverBranchFilterSql,
  getAdminAllowedBranchIds,
  resolveDriverBranchId,
  sharedResourceIds,
} from "../lib/branch-filter.js";
import { getDriverBranchId } from "../branch-storage.js";
import { resolveDriverDepot } from "../lib/depot.js";
import { effectiveThresholds, readSafetySettings } from "../lib/safety-settings-store.js";
import {
  ensureDefaultBranch,
  getAdminBranchIds,
  syncPrimaryBranchFromCompanyProfile,
  type BranchRow,
} from "../lib/admin-auth.js";

/** Stable stop-id set for detecting real list edits vs status-only syncs. */
function stopMembershipKey(stopsJsonOrArray: string | unknown[] | undefined): string {
  try {
    const stops = Array.isArray(stopsJsonOrArray)
      ? stopsJsonOrArray
      : JSON.parse(String(stopsJsonOrArray || "[]"));
    if (!Array.isArray(stops)) return "";
    return stops
      .map((raw) => {
        const stop = raw as Record<string, unknown>;
        return String(stop.stopId ?? stop.id ?? "").trim();
      })
      .filter(Boolean)
      .sort()
      .join("|");
  } catch {
    return "";
  }
}

/** Route plans explicitly shared to any of the given branches, excluding ones already loaded. */
function loadSharedRoutePlans(
  companyId: string,
  targetBranchIds: string[],
  excludeRunIds: Set<string>,
): RoutePlanRow[] {
  const ids = sharedResourceIds(companyId, "route", targetBranchIds).filter(
    (id) => !excludeRunIds.has(id),
  );
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ? AND route_run_id IN (${placeholders})`,
    )
    .all(companyId, ...ids) as RoutePlanRow[];
}

/** Geofences explicitly shared to any of the given branches, excluding ones already loaded. */
function loadSharedGeofences(
  companyId: string,
  targetBranchIds: string[],
  excludeIds: Set<string>,
  approvalStatus?: string,
): GeofenceRow[] {
  const ids = sharedResourceIds(companyId, "geofence", targetBranchIds).filter(
    (id) => !excludeIds.has(id),
  );
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `${GEOFENCE_SELECT}
       WHERE company_id = ? AND id IN (${placeholders})
       ${approvalStatus ? "AND approval_status = ?" : ""}`,
    )
    .all(
      ...(approvalStatus
        ? [companyId, ...ids, approvalStatus]
        : [companyId, ...ids]),
    ) as GeofenceRow[];
}

const GEOFENCE_SELECT = `SELECT id, company_id, name, latitude, longitude, radius_meters, source, approval_status,
  driver_device_id, stop_id, route_id, last_triggered_at_millis, branch_id, created_at, updated_at
  FROM geofences`;

function requireAdmin(c: { get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined }) {
  return hasAdminAccess(c);
}

companyRoutes.get("/route47/companies/:companyId/admin-route-plans", (c) => {
  const companyId = c.req.param("companyId");
  const driverId = c.req.query("driverId")?.trim();
  const admin = c.get("admin");
  const branchFilter = driverBranchFilterSql(companyId, admin);

  const rows = db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ?
       ${driverId ? "AND (driver_id = ? OR driver_id = '')" : ""}
       ${branchFilter.clause}
       ORDER BY updated_at DESC`
    )
    .all(...(driverId ? [companyId, driverId, ...branchFilter.params] : [companyId, ...branchFilter.params])) as RoutePlanRow[];

  // Branch-restricted admins also see routes explicitly shared to their branches.
  const allowedBranches = getAdminAllowedBranchIds(companyId, admin);
  if (!driverId && allowedBranches !== null) {
    rows.push(
      ...loadSharedRoutePlans(
        companyId,
        allowedBranches,
        new Set(rows.map((row) => row.route_run_id)),
      ),
    );
  }

  const adminRoutePlans = rows.map(routePlanToJson);

  return c.json({
    message: `${adminRoutePlans.length} admin route plan(s).`,
    adminRoutePlans,
  });
});

companyRoutes.post("/route47/companies/:companyId/admin-route-plans", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);
  if (!company) {
    return c.json({ message: "Company not found." }, 404);
  }

  const body = await c.req.json<{
    adminRoutePlans?: unknown[];
    routePlans?: unknown[];
    routeRunId?: string;
    routeDateIso?: string;
    driverId?: string;
    vehicleId?: string;
    status?: string;
    stops?: unknown[];
  }>();

  const plans = body.adminRoutePlans ?? body.routePlans ?? (body.routeRunId ? [body] : []);
  if (!Array.isArray(plans) || plans.length === 0) {
    return c.json({ message: "Provide adminRoutePlans array or a single route plan." }, 400);
  }

  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO route_plans (
      route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, route_run_id) DO UPDATE SET
      driver_id = excluded.driver_id,
      vehicle_id = excluded.vehicle_id,
      route_date_iso = excluded.route_date_iso,
      status = excluded.status,
      stops_json = excluded.stops_json,
      updated_at = excluded.updated_at`
  );

  const published: string[] = [];

  for (const raw of plans) {
    const plan = raw as Record<string, unknown>;
    const driverId = String(plan.driverId ?? plan.driver_id ?? "").trim();
    const routeDateIso = String(
      plan.routeDateIso ?? plan.route_date_iso ?? new Date().toISOString().slice(0, 10),
    ).trim();
    const routeRunId = driverId
      ? canonicalRouteRunId(driverId, routeDateIso)
      : String(plan.routeRunId ?? plan.route_run_id ?? "").trim();
    if (!routeRunId) continue;

    const existing = db
      .prepare(
        `SELECT driver_id AS driverId, stops_json AS stopsJson FROM route_plans WHERE company_id = ? AND route_run_id = ?`,
      )
      .get(companyId, routeRunId) as { driverId?: string; stopsJson?: string } | undefined;

    const incomingStops = Array.isArray(plan.stops) ? plan.stops : [];
    // Admin always publishes the driver's full current list — replace stops so
    // deletes stick. (Partial merge kept deleted stops alive on the server.)
    const stops = incomingStops;

    upsert.run(
      routeRunId,
      companyId,
      driverId,
      String(plan.vehicleId ?? plan.vehicle_id ?? ""),
      routeDateIso,
      String(plan.status ?? "published"),
      JSON.stringify(stops),
      now,
      now
    );
    published.push(routeRunId);

    if (driverId) {
      deleteDuplicateRoutePlansForDriverDay(companyId, driverId, routeDateIso, routeRunId);
    }

    notifyRoutePlanPublished({
      companyId,
      routeRunId,
      driverId,
      previousDriverId: existing?.driverId,
      stopCount: stops.length,
      isNew: !existing,
    });
  }

  return c.json({
    message: `Published ${published.length} route plan(s).`,
    publishedRouteRunIds: published,
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/company", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);
  if (!company) {
    return c.json({ message: "Company not found." }, 404);
  }

  const primary = ensureDefaultBranch(companyId);

  return c.json({
    id: company.id,
    name: company.name,
    address: primary.address ?? "",
    latitude: primary.latitude ?? null,
    longitude: primary.longitude ?? null,
    createdAt: new Date(company.createdAt).toISOString(),
    updatedAt: null,
  });
});

companyRoutes.patch("/route47/companies/:companyId/admin/company", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{
    name?: string;
    address?: string;
    latitude?: number | null;
    longitude?: number | null;
    contactEmail?: string;
    contactPhone?: string;
  }>();

  const now = Date.now();
  const name = body.name?.trim() || companyId;

  db.prepare(
    `INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  ).run(companyId, name, now);

  syncPrimaryBranchFromCompanyProfile(companyId, {
    address: body.address,
    latitude: body.latitude,
    longitude: body.longitude,
  });

  const company = getCompany(companyId);

  return c.json({
    id: companyId,
    name: company?.name ?? name,
    address: body.address ?? "",
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    contactEmail: body.contactEmail ?? "",
    contactPhone: body.contactPhone ?? "",
    createdAt: company ? new Date(company.createdAt).toISOString() : new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/snapshot", (c) => {
  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);
  const driverDeviceId = String(c.get("driverDeviceId") ?? "").trim();
  const sessionDriverId =
    c.get("driverId")?.trim() ||
    c.req.header("X-Route47-Driver-Id")?.trim() ||
    "";
  const admin = c.get("admin");
  const routeBranchFilter = driverBranchFilterSql(companyId, admin);
  const geofenceBranchFilter = branchColumnFilterSql(companyId, admin);

  const routePlanRows = db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ?
       ${sessionDriverId ? "AND driver_id = ?" : ""}
       ${routeBranchFilter.clause}
       ORDER BY published_at DESC`
    )
    .all(
      ...(sessionDriverId
        ? [companyId, sessionDriverId, ...routeBranchFilter.params]
        : [companyId, ...routeBranchFilter.params]),
    ) as RoutePlanRow[];

  // Branch-restricted admins also see routes explicitly shared to their branches.
  const adminAllowedBranches = getAdminAllowedBranchIds(companyId, admin);
  if (!sessionDriverId && adminAllowedBranches !== null) {
    routePlanRows.push(
      ...loadSharedRoutePlans(
        companyId,
        adminAllowedBranches,
        new Set(routePlanRows.map((row) => row.route_run_id)),
      ),
    );
  }

  const routePlans = routePlanRows.map(routePlanToJson);

  const driverBranchId = sessionDriverId ? getDriverBranchId(companyId, sessionDriverId) : "";
  const geofenceConditions: string[] = ["company_id = ?", "approval_status = 'approved'"];
  if (sessionDriverId) {
    geofenceConditions.push("COALESCE(NULLIF(branch_id, ''), ?) = ?");
  } else if (geofenceBranchFilter.clause) {
    geofenceConditions.push(geofenceBranchFilter.clause.trim().replace(/^AND\s+/i, ""));
  }

  const geofenceParams: Array<string | number> = [companyId];
  if (sessionDriverId) {
    geofenceParams.push(defaultBranchId(companyId), driverBranchId);
  } else {
    geofenceParams.push(...geofenceBranchFilter.params);
  }

  const geofenceRows = db
    .prepare(
      `${GEOFENCE_SELECT}
       WHERE ${geofenceConditions.join(" AND ")}
       ORDER BY updated_at DESC`,
    )
    .all(...geofenceParams) as GeofenceRow[];

  // Include approved geofences explicitly shared to the caller's branch(es).
  const geofenceShareTargets = sessionDriverId
    ? [driverBranchId].filter(Boolean)
    : adminAllowedBranches ?? [];
  if (geofenceShareTargets.length > 0) {
    geofenceRows.push(
      ...loadSharedGeofences(
        companyId,
        geofenceShareTargets,
        new Set(geofenceRows.map((row) => row.id)),
        "approved",
      ),
    );
  }

  const geofences = geofenceRows.map((row) => {
    const json = geofenceToJson(row);
    return {
      id: json.id,
      name: json.name,
      latitude: json.latitude,
      longitude: json.longitude,
      radiusMeters: json.radiusMeters,
      stopId: json.stopId,
      routeId: json.routeId,
      lastTriggeredAtMillis: json.lastTriggeredAtMillis,
    };
  });

  const rejectedGeofenceIds: string[] = driverDeviceId
    ? (
        db
          .prepare(
            `SELECT id FROM geofences
             WHERE company_id = ? AND driver_device_id = ? AND approval_status = 'rejected'`,
          )
          .all(companyId, driverDeviceId) as Array<{ id: string }>
      ).map((row) => row.id)
    : [];

  const depot = sessionDriverId
    ? resolveDriverDepot(companyId, sessionDriverId)
    : null;

  const safetySettings = readSafetySettings(companyId);

  return c.json({
    message: "Admin snapshot ready.",
    snapshot: {
      companyId,
      companyName: company?.name ?? companyId,
      serverTimeMillis: Date.now(),
      adminRoutePlans: routePlans,
      geofences,
      rejectedGeofenceIds,
      depot,
      safetySettings,
      safetyEffectiveThresholds: effectiveThresholds(safetySettings),
    },
  });
});

companyRoutes.get("/route47/companies/:companyId/driver/depot", (c) => {
  const companyId = c.req.param("companyId");
  const sessionDriverId =
    c.get("driverId")?.trim() ||
    c.req.header("X-Route47-Driver-Id")?.trim() ||
    "";

  if (!sessionDriverId) {
    return c.json({ message: "Driver authentication required." }, 401);
  }

  const depot = resolveDriverDepot(companyId, sessionDriverId);
  if (!depot) {
    return c.json({ message: "Depot not found for this driver." }, 404);
  }

  const company = getCompany(companyId);

  return c.json({
    message: "Driver depot ready.",
    companyName: company?.name ?? companyId,
    depot,
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/geofences", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const status = c.req.query("approvalStatus")?.trim();
  const admin = c.get("admin");
  const branchFilter = branchColumnFilterSql(companyId, admin);

  const rows = db
    .prepare(
      `${GEOFENCE_SELECT}
       WHERE company_id = ?
       ${status ? "AND approval_status = ?" : ""}
       ${branchFilter.clause}
       ORDER BY updated_at DESC`
    )
    .all(...(status ? [companyId, status, ...branchFilter.params] : [companyId, ...branchFilter.params])) as GeofenceRow[];

  // Branch-restricted admins also see geofences explicitly shared to their branches.
  const allowedBranches = getAdminAllowedBranchIds(companyId, admin);
  if (allowedBranches !== null) {
    rows.push(
      ...loadSharedGeofences(
        companyId,
        allowedBranches,
        new Set(rows.map((row) => row.id)),
        status || undefined,
      ),
    );
  }

  return c.json({
    message: `${rows.length} geofence(s).`,
    geofences: rows.map(geofenceToJson),
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/geofences", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{
    id?: string;
    name?: string;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
    approvalStatus?: string;
    stopId?: string;
    routeId?: string;
    lastTriggeredAtMillis?: number;
    branchId?: string;
  }>();

  const id = body.id?.trim() || `gf-${crypto.randomBytes(4).toString("hex")}`;
  const now = Date.now();
  const admin = c.get("admin");
  const allowedBranches = getAdminAllowedBranchIds(companyId, admin);
  const branchId =
    resolveDriverBranchId(companyId, body.branchId) ||
    (allowedBranches && allowedBranches.length > 0
      ? allowedBranches[0]
      : defaultBranchId(companyId));

  db.prepare(
    `INSERT INTO geofences (
      id, company_id, name, latitude, longitude, radius_meters, source, approval_status,
      driver_device_id, stop_id, route_id, last_triggered_at_millis, branch_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, '', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, id) DO UPDATE SET
      name = excluded.name,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      radius_meters = excluded.radius_meters,
      approval_status = excluded.approval_status,
      stop_id = excluded.stop_id,
      route_id = excluded.route_id,
      last_triggered_at_millis = excluded.last_triggered_at_millis,
      branch_id = excluded.branch_id,
      updated_at = excluded.updated_at`
  ).run(
    id,
    companyId,
    body.name ?? "Admin geofence",
    body.latitude ?? 0,
    body.longitude ?? 0,
    body.radiusMeters ?? 120,
    body.approvalStatus ?? "approved",
    body.stopId ?? "",
    body.routeId ?? "",
    body.lastTriggeredAtMillis ?? 0,
    branchId,
    now,
    now
  );

  notifyGeofencesChanged(companyId);

  return c.json({ message: "Geofence saved.", id });
});

companyRoutes.patch("/route47/companies/:companyId/admin/geofences/:geofenceId", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const geofenceId = c.req.param("geofenceId");
  const body = await c.req.json<{
    name?: string;
    approvalStatus?: string;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
    stopId?: string;
    routeId?: string;
    lastTriggeredAtMillis?: number;
  }>();

  const existing = db
    .prepare(`SELECT id FROM geofences WHERE company_id = ? AND id = ?`)
    .get(companyId, geofenceId);

  if (!existing) {
    return c.json({ message: "Geofence not found." }, 404);
  }

  const row = db
    .prepare(`${GEOFENCE_SELECT} WHERE company_id = ? AND id = ?`)
    .get(companyId, geofenceId) as GeofenceRow;

  const now = Date.now();

  db.prepare(
    `UPDATE geofences SET
      name = ?,
      latitude = ?,
      longitude = ?,
      radius_meters = ?,
      approval_status = ?,
      stop_id = ?,
      route_id = ?,
      last_triggered_at_millis = ?,
      updated_at = ?
     WHERE company_id = ? AND id = ?`
  ).run(
    body.name ?? row.name,
    body.latitude ?? row.latitude,
    body.longitude ?? row.longitude,
    body.radiusMeters ?? row.radius_meters,
    body.approvalStatus ?? row.approval_status,
    body.stopId ?? row.stop_id,
    body.routeId ?? row.route_id,
    body.lastTriggeredAtMillis ?? row.last_triggered_at_millis,
    now,
    companyId,
    geofenceId
  );

  notifyGeofencesChanged(companyId, row.driver_device_id);

  return c.json({
    message: `Geofence ${body.approvalStatus ? `${body.approvalStatus}.` : "updated."}`,
    id: geofenceId,
    approvalStatus: body.approvalStatus ?? row.approval_status,
  });
});

companyRoutes.delete("/route47/companies/:companyId/admin/geofences/:geofenceId", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const geofenceId = c.req.param("geofenceId");

  const existingRow = db
    .prepare(`${GEOFENCE_SELECT} WHERE company_id = ? AND id = ?`)
    .get(companyId, geofenceId) as GeofenceRow | undefined;

  if (!existingRow) {
    return c.json({ message: "Geofence not found." }, 404);
  }

  db.prepare(`DELETE FROM geofences WHERE company_id = ? AND id = ?`).run(companyId, geofenceId);

  notifyGeofencesChanged(companyId, existingRow.driver_device_id);

  return c.json({ message: "Geofence deleted.", id: geofenceId });
});

companyRoutes.post("/route47/companies/:companyId/geofences/sync", async (c) => {
  const companyId = c.get("companyId");
  const body = await c.req.json<{
    companyId?: string;
    driverDeviceId?: string;
    vehicleId?: string;
    syncedAtMillis?: number;
    deletedGeofenceIds?: string[];
    geofences?: Array<{
      id?: string;
      name?: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      stopId?: string;
      routeId?: string;
      lastTriggeredAtMillis?: number;
    }>;
  }>();

  const driverDeviceId = body.driverDeviceId ?? c.get("driverDeviceId");
  const sessionDriverId = c.get("driverId")?.trim() ?? "";
  const branchId = getDriverBranchId(companyId, sessionDriverId);
  const incoming = body.geofences ?? [];
  const deletedIds = (body.deletedGeofenceIds ?? [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  const now = body.syncedAtMillis ?? Date.now();

  if (deletedIds.length > 0 && driverDeviceId) {
    const remove = db.prepare(
      `DELETE FROM geofences WHERE company_id = ? AND id = ? AND driver_device_id = ?`,
    );
    for (const id of deletedIds) {
      remove.run(companyId, id, driverDeviceId);
    }
  }

  const upsert = db.prepare(
    `INSERT INTO geofences (
      id, company_id, name, latitude, longitude, radius_meters, source, approval_status,
      driver_device_id, stop_id, route_id, last_triggered_at_millis, branch_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'driver', 'pending', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, id) DO UPDATE SET
      name = excluded.name,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      radius_meters = excluded.radius_meters,
      driver_device_id = excluded.driver_device_id,
      stop_id = excluded.stop_id,
      route_id = excluded.route_id,
      last_triggered_at_millis = CASE
        WHEN excluded.last_triggered_at_millis > 0 THEN excluded.last_triggered_at_millis
        ELSE geofences.last_triggered_at_millis
      END,
      branch_id = excluded.branch_id,
      updated_at = excluded.updated_at`
  );

  for (const geofence of incoming) {
    const id = geofence.id?.trim() || `gf-${crypto.randomBytes(4).toString("hex")}`;
    upsert.run(
      id,
      companyId,
      geofence.name ?? "Driver geofence",
      geofence.latitude ?? 0,
      geofence.longitude ?? 0,
      geofence.radiusMeters ?? 120,
      driverDeviceId,
      geofence.stopId ?? "",
      geofence.routeId ?? "",
      geofence.lastTriggeredAtMillis ?? 0,
      branchId,
      now,
      now
    );
  }

  return c.json({
    message: `${incoming.length} geofence(s) synced for admin approval.`,
    deletedCount: deletedIds.length,
  });
});

companyRoutes.post("/route47/companies/:companyId/driver-route-plans/sync", async (c) => {
  const companyId = c.get("companyId");
  const body = await c.req.json<{
    routeRunId?: string;
    routeDateIso?: string;
    driverId?: string;
    vehicleId?: string;
    status?: string;
    stops?: unknown[];
    /** Driver's last known server plan updatedAt (ms). Used for admin-wins conflict. */
    baseUpdatedAtMillis?: number;
  }>();

  const driverId = String(body.driverId ?? c.get("driverId") ?? "").trim();
  const routeDateIso = String(body.routeDateIso ?? new Date().toISOString().slice(0, 10)).trim();
  const routeRunId = driverId
    ? canonicalRouteRunId(driverId, routeDateIso)
    : String(body.routeRunId ?? "").trim();
  if (!routeRunId) {
    return c.json({ message: "routeRunId or driverId is required." }, 400);
  }

  const vehicleId = String(body.vehicleId ?? c.get("vehicleId") ?? "").trim();
  const incomingStops = Array.isArray(body.stops) ? body.stops : [];
  const now = Date.now();

  const existing = db
    .prepare(
      `SELECT stops_json AS stopsJson, updated_at AS updatedAt
       FROM route_plans WHERE company_id = ? AND route_run_id = ?`,
    )
    .get(companyId, routeRunId) as { stopsJson?: string; updatedAt?: number } | undefined;

  let stops = incomingStops;
  let adminWins = false;
  const baseUpdatedAt = Number(body.baseUpdatedAtMillis) || 0;
  const existingUpdatedAt = Number(existing?.updatedAt) || 0;

  const existingMembership = stopMembershipKey(existing?.stopsJson);
  const incomingMembership = stopMembershipKey(JSON.stringify(incomingStops));
  const incomingIsStrictSubset =
    Boolean(existing?.stopsJson) &&
    existingMembership.length > 0 &&
    incomingMembership.length > 0 &&
    incomingMembership !== existingMembership &&
    incomingMembership.split("|").every((id) => id && existingMembership.split("|").includes(id)) &&
    incomingMembership.split("|").length < existingMembership.split("|").length;

  // Admin published after the driver's last known revision, OR a stale driver
  // push is trying to shrink the list after admin added stops.
  const shouldPreserveAdminMembership =
    Boolean(existing?.stopsJson) &&
    existingUpdatedAt > 0 &&
    (
      (baseUpdatedAt > 0 && existingUpdatedAt > baseUpdatedAt) ||
      (incomingIsStrictSubset && baseUpdatedAt > 0 && existingUpdatedAt >= baseUpdatedAt)
    );

  if (shouldPreserveAdminMembership) {
    adminWins = true;
    try {
      const existingStops = JSON.parse(existing!.stopsJson || "[]") as Array<Record<string, unknown>>;
      const incomingById = new Map<string, Record<string, unknown>>();
      for (const raw of incomingStops) {
        const stop = raw as Record<string, unknown>;
        const id = String(stop.stopId ?? stop.id ?? "").trim();
        if (id) incomingById.set(id, stop);
      }
      stops = existingStops.map((serverStop) => {
        const id = String(serverStop.stopId ?? serverStop.id ?? "").trim();
        const fromDriver = id ? incomingById.get(id) : undefined;
        if (!fromDriver) return serverStop;
        return {
          ...serverStop,
          stopStatus: fromDriver.stopStatus ?? fromDriver.status ?? serverStop.stopStatus,
          notes: fromDriver.notes ?? serverStop.notes,
          poNumber: fromDriver.poNumber ?? serverStop.poNumber,
        };
      });
    } catch {
      stops = incomingStops;
      adminWins = false;
    }
  }

  db.prepare(
    `INSERT INTO route_plans (
      route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, route_run_id) DO UPDATE SET
      driver_id = excluded.driver_id,
      vehicle_id = excluded.vehicle_id,
      route_date_iso = excluded.route_date_iso,
      status = excluded.status,
      stops_json = excluded.stops_json,
      updated_at = excluded.updated_at`
  ).run(
    routeRunId,
    companyId,
    driverId,
    vehicleId,
    routeDateIso,
    String(body.status ?? "in_progress"),
    JSON.stringify(stops),
    // Preserve published_at / updated_at when admin wins so the next driver
    // download still sees the admin revision as newer.
    adminWins ? (existingUpdatedAt || now) : now,
    adminWins ? existingUpdatedAt : now
  );

  if (driverId) {
    deleteDuplicateRoutePlansForDriverDay(companyId, driverId, routeDateIso, routeRunId);
  }

  // Only alert admins when stop membership actually changed. Routine open-app /
  // status syncs must not spam "current list updated" notifications.
  const previousMembership = stopMembershipKey(existing?.stopsJson);
  const nextMembership = stopMembershipKey(JSON.stringify(stops));
  if (!existing || previousMembership !== nextMembership) {
    notifyDriverRoutePlanSynced({
      companyId,
      routeRunId,
      driverId,
      stopCount: stops.length,
      isNew: !existing,
    });
  }

  return c.json({
    message: adminWins
      ? "Driver route plan synced (admin membership preserved)."
      : "Driver route plan synced.",
    routeRunId,
    stopCount: stops.length,
    adminWins,
    updatedAtMillis: adminWins ? (existingUpdatedAt || now) : now,
  });
});
