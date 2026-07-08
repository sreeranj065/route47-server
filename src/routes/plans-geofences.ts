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

const GEOFENCE_SELECT = `SELECT id, company_id, name, latitude, longitude, radius_meters, source, approval_status,
  driver_device_id, stop_id, route_id, last_triggered_at_millis, created_at, updated_at
  FROM geofences`;

function requireAdmin(c: { get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined }) {
  return hasAdminAccess(c);
}

companyRoutes.get("/route47/companies/:companyId/admin-route-plans", (c) => {
  const companyId = c.req.param("companyId");
  const driverId = c.req.query("driverId")?.trim();

  const rows = db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ?
       ${driverId ? "AND (driver_id = ? OR driver_id = '')" : ""}
       ORDER BY updated_at DESC`
    )
    .all(...(driverId ? [companyId, driverId] : [companyId])) as RoutePlanRow[];

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

  return c.json({
    id: company.id,
    name: company.name,
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

  const routePlans = (
    db
      .prepare(
        `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
         FROM route_plans WHERE company_id = ? ORDER BY published_at DESC`
      )
      .all(companyId) as RoutePlanRow[]
  ).map(routePlanToJson);

  const geofences = (
    db
      .prepare(
        `${GEOFENCE_SELECT}
         WHERE company_id = ? AND approval_status = 'approved'
         ORDER BY updated_at DESC`
      )
      .all(companyId) as GeofenceRow[]
  ).map((row) => {
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

  return c.json({
    message: "Admin snapshot ready.",
    snapshot: {
      companyId,
      companyName: company?.name ?? companyId,
      serverTimeMillis: Date.now(),
      adminRoutePlans: routePlans,
      geofences,
      rejectedGeofenceIds,
    },
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/geofences", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const status = c.req.query("approvalStatus")?.trim();

  const rows = db
    .prepare(
      `${GEOFENCE_SELECT}
       WHERE company_id = ?
       ${status ? "AND approval_status = ?" : ""}
       ORDER BY updated_at DESC`
    )
    .all(...(status ? [companyId, status] : [companyId])) as GeofenceRow[];

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
  }>();

  const id = body.id?.trim() || `gf-${crypto.randomBytes(4).toString("hex")}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO geofences (
      id, company_id, name, latitude, longitude, radius_meters, source, approval_status,
      driver_device_id, stop_id, route_id, last_triggered_at_millis, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, '', ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, id) DO UPDATE SET
      name = excluded.name,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      radius_meters = excluded.radius_meters,
      approval_status = excluded.approval_status,
      stop_id = excluded.stop_id,
      route_id = excluded.route_id,
      last_triggered_at_millis = excluded.last_triggered_at_millis,
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
      driver_device_id, stop_id, route_id, last_triggered_at_millis, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'driver', 'pending', ?, ?, ?, ?, ?, ?)
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
  const stops = Array.isArray(body.stops) ? body.stops : [];
  const now = Date.now();

  const existing = db
    .prepare(`SELECT stops_json AS stopsJson FROM route_plans WHERE company_id = ? AND route_run_id = ?`)
    .get(companyId, routeRunId) as { stopsJson?: string } | undefined;

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
    now,
    now
  );

  if (driverId) {
    deleteDuplicateRoutePlansForDriverDay(companyId, driverId, routeDateIso, routeRunId);
  }

  notifyDriverRoutePlanSynced({
    companyId,
    routeRunId,
    driverId,
    stopCount: stops.length,
    isNew: !existing,
  });

  return c.json({
    message: "Driver route plan synced.",
    routeRunId,
    stopCount: stops.length,
  });
});
