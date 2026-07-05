import { companyRoutes } from "./auth.js";
import { db } from "../db.js";

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
  return c.json({ message: "Daily report accepted." });
});
