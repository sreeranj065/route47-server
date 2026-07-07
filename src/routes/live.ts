import crypto from "node:crypto";
import { isValidAdminKey } from "../auth.js";
import { companyRoutes } from "./auth.js";
import { db, dailyReportToJson, type DailyReportRow } from "../db.js";
import { applyStopProgressToLatestPlan } from "../lib/route-plan-sync.js";

function readAdminKey(c: { req: { header: (name: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return c.req.header("X-Route47-Admin-Key")?.trim() ?? bearer;
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  return isValidAdminKey(readAdminKey(c));
}

companyRoutes.post("/route47/companies/:companyId/devices/heartbeat", async (c) => {
  const companyId = c.get("companyId");
  const body = await c.req.json<{
    companyId?: string;
    driverId?: string;
    driverDeviceId?: string;
    vehicleId?: string;
    routeRunId?: string;
    activeStopId?: string;
    latitude?: number;
    longitude?: number;
    batteryLevelPercent?: number;
    networkStatus?: string;
    appVersionName?: string;
    appBuildType?: string;
    createdAtMillis?: number;
  }>();

  const createdAt = body.createdAtMillis ?? Date.now();

  db.prepare(
    `INSERT INTO heartbeats (
      company_id, driver_id, driver_device_id, vehicle_id, route_run_id, active_stop_id,
      latitude, longitude, battery_level_percent, network_status, app_version_name,
      app_build_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    body.driverId ?? c.get("driverId"),
    body.driverDeviceId ?? c.get("driverDeviceId"),
    body.vehicleId ?? c.get("vehicleId"),
    body.routeRunId ?? "",
    body.activeStopId ?? "",
    body.latitude ?? null,
    body.longitude ?? null,
    body.batteryLevelPercent ?? null,
    body.networkStatus ?? "unknown",
    body.appVersionName ?? "",
    body.appBuildType ?? "",
    createdAt
  );

  return c.json({ message: "Device heartbeat stored." });
});

companyRoutes.post("/route47/companies/:companyId/routes/progress", async (c) => {
  const companyId = c.get("companyId");
  const body = await c.req.json<{
    companyId?: string;
    driverId?: string;
    driverDeviceId?: string;
    vehicleId?: string;
    routeRunId?: string;
    stopId?: string;
    stopNumber?: number;
    stopStatus?: string;
    eventType?: string;
    message?: string;
    latitude?: number;
    longitude?: number;
    createdAtMillis?: number;
  }>();

  db.prepare(
    `INSERT INTO route_progress (
      company_id, driver_id, driver_device_id, vehicle_id, route_run_id, stop_id,
      stop_number, stop_status, event_type, message, latitude, longitude, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    body.driverId ?? c.get("driverId"),
    body.driverDeviceId ?? c.get("driverDeviceId"),
    body.vehicleId ?? c.get("vehicleId"),
    body.routeRunId ?? "",
    body.stopId ?? "",
    body.stopNumber ?? 0,
    body.stopStatus ?? "",
    body.eventType ?? "",
    body.message ?? "",
    body.latitude ?? null,
    body.longitude ?? null,
    body.createdAtMillis ?? Date.now()
  );

  const driverId = String(body.driverId ?? c.get("driverId") ?? "").trim();
  const stopId = String(body.stopId ?? "").trim();
  const stopStatus = String(body.stopStatus ?? "").trim();
  if (driverId && stopId && stopStatus) {
    applyStopProgressToLatestPlan(companyId, driverId, stopId, stopStatus);
  }

  return c.json({ message: "Route progress update stored." });
});

function latestHeartbeats(companyId: string, maxAgeMs = 1000 * 60 * 15) {
  const cutoff = Date.now() - maxAgeMs;
  return db
    .prepare(
      `SELECT h.company_id AS companyId, h.driver_id AS driverId, h.driver_device_id AS driverDeviceId,
              h.vehicle_id AS vehicleId, h.route_run_id AS routeRunId, h.active_stop_id AS activeStopId,
              h.latitude, h.longitude, h.battery_level_percent AS batteryLevelPercent,
              h.network_status AS networkStatus, h.app_version_name AS appVersionName,
              h.created_at AS createdAtMillis
       FROM heartbeats h
       INNER JOIN (
         SELECT driver_id, MAX(created_at) AS max_created
         FROM heartbeats
         WHERE company_id = ? AND created_at >= ?
         GROUP BY driver_id
       ) latest ON latest.driver_id = h.driver_id AND latest.max_created = h.created_at
       WHERE h.company_id = ?`
    )
    .all(companyId, cutoff, companyId) as Array<Record<string, unknown>>;
}

companyRoutes.get("/route47/companies/:companyId/admin/live-locations", (c) => {
  const companyId = c.req.param("companyId");
  const locations = latestHeartbeats(companyId);

  return c.json({
    message: `${locations.length} live location(s).`,
    locations,
    liveLocations: locations,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/live-updates", (c) => {
  const companyId = c.req.param("companyId");
  const locations = latestHeartbeats(companyId);

  return c.json({
    message: `${locations.length} live update(s).`,
    updates: locations,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.get("/route47/companies/:companyId/devices/locations", (c) => {
  const companyId = c.req.param("companyId");
  const locations = latestHeartbeats(companyId);

  return c.json({
    message: `${locations.length} device location(s).`,
    devices: locations,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.post("/route47/companies/:companyId/sync/request", async (c) => {
  const body = await c.req.json<{ syncTypes?: string[] }>().catch(() => ({ syncTypes: [] }));
  const syncTypes = body.syncTypes ?? [];

  return c.json({
    message: `Sync request accepted for: ${syncTypes.join(", ") || "all"}.`,
    acceptedSyncTypes: syncTypes,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.post("/route47/companies/:companyId/reports/daily", async (c) => {
  const companyId = c.req.param("companyId");
  const body = await c.req.json<{
    routeRunId?: string;
    routeDateIso?: string;
    totalStops?: number;
    completedStops?: number;
    skippedStops?: number;
    failedStops?: number;
    proofCount?: number;
    receiptCount?: number;
    totalDistanceMeters?: number;
    totalDriveTimeSeconds?: number;
    createdAtMillis?: number;
    driverId?: string;
    driverDeviceId?: string;
    vehicleId?: string;
  }>();

  const routeRunId = String(body.routeRunId ?? "").trim();
  if (!routeRunId) {
    return c.json({ message: "routeRunId is required." }, 400);
  }

  const driverId = String(body.driverId ?? c.get("driverId") ?? "").trim();
  const driverDeviceId = String(body.driverDeviceId ?? c.get("driverDeviceId") ?? "").trim();
  const vehicleId = String(body.vehicleId ?? c.get("vehicleId") ?? "").trim();
  const routeDateIso = String(
    body.routeDateIso ?? new Date().toISOString().slice(0, 10),
  ).trim();
  const now = Date.now();
  const createdAt = Number(body.createdAtMillis ?? now);
  const reportId = `dr-${crypto
    .createHash("sha1")
    .update(`${companyId}|${driverId}|${routeRunId}|${routeDateIso}`)
    .digest("hex")
    .slice(0, 16)}`;

  db.prepare(
    `INSERT INTO daily_reports (
      report_id, company_id, driver_id, driver_device_id, vehicle_id, route_run_id,
      route_date_iso, total_stops, completed_stops, skipped_stops, failed_stops,
      proof_count, receipt_count, total_distance_meters, total_drive_time_seconds,
      created_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, driver_id, route_run_id, route_date_iso) DO UPDATE SET
      driver_device_id = excluded.driver_device_id,
      vehicle_id = excluded.vehicle_id,
      total_stops = excluded.total_stops,
      completed_stops = excluded.completed_stops,
      skipped_stops = excluded.skipped_stops,
      failed_stops = excluded.failed_stops,
      proof_count = excluded.proof_count,
      receipt_count = excluded.receipt_count,
      total_distance_meters = excluded.total_distance_meters,
      total_drive_time_seconds = excluded.total_drive_time_seconds,
      created_at = excluded.created_at,
      received_at = excluded.received_at`
  ).run(
    reportId,
    companyId,
    driverId,
    driverDeviceId,
    vehicleId,
    routeRunId,
    routeDateIso,
    Number(body.totalStops ?? 0),
    Number(body.completedStops ?? 0),
    Number(body.skippedStops ?? 0),
    Number(body.failedStops ?? 0),
    Number(body.proofCount ?? 0),
    Number(body.receiptCount ?? 0),
    Number(body.totalDistanceMeters ?? 0),
    Number(body.totalDriveTimeSeconds ?? 0),
    createdAt,
    now,
  );

  return c.json({
    message: "Daily report stored.",
    reportId,
    routeRunId,
    routeDateIso,
  });
});

companyRoutes.get("/route47/companies/:companyId/reports/daily", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const routeDateIso = c.req.query("routeDateIso")?.trim();
  const driverId = c.req.query("driverId")?.trim();
  const routeRunId = c.req.query("routeRunId")?.trim();
  const fromDateIso = c.req.query("fromDateIso")?.trim();
  const toDateIso = c.req.query("toDateIso")?.trim();

  const conditions = ["company_id = ?"];
  const params: Array<string> = [companyId];

  if (routeDateIso) {
    conditions.push("route_date_iso = ?");
    params.push(routeDateIso);
  }
  if (driverId) {
    conditions.push("driver_id = ?");
    params.push(driverId);
  }
  if (routeRunId) {
    conditions.push("route_run_id = ?");
    params.push(routeRunId);
  }
  if (fromDateIso) {
    conditions.push("route_date_iso >= ?");
    params.push(fromDateIso);
  }
  if (toDateIso) {
    conditions.push("route_date_iso <= ?");
    params.push(toDateIso);
  }

  const rows = db
    .prepare(
      `SELECT report_id, company_id, driver_id, driver_device_id, vehicle_id, route_run_id,
              route_date_iso, total_stops, completed_stops, skipped_stops, failed_stops,
              proof_count, receipt_count, total_distance_meters, total_drive_time_seconds,
              created_at, received_at
       FROM daily_reports
       WHERE ${conditions.join(" AND ")}
       ORDER BY route_date_iso DESC, received_at DESC
       LIMIT 500`,
    )
    .all(...params) as DailyReportRow[];

  return c.json({
    message: `${rows.length} daily report(s).`,
    reports: rows.map(dailyReportToJson),
  });
});
