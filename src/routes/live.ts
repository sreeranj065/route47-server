import crypto from "node:crypto";
import { hasAdminAccess } from "../lib/route-admin.js";
import { companyRoutes } from "./auth.js";
import { db, dailyReportToJson, type DailyReportRow } from "../db.js";
import { applyStopProgressToLatestPlan, summarizeRoutePlanStops } from "../lib/route-plan-sync.js";
import {
  filterRowsByAccessibleDrivers,
} from "../lib/branch-filter.js";

function requireAdmin(c: { get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined }) {
  return hasAdminAccess(c);
}

companyRoutes.post("/route47/companies/:companyId/devices/heartbeat", async (c) => {
  const companyId = c.get("companyId");
  type HeartbeatBody = {
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
    speedKmh?: number;
    headingDegrees?: number;
    routeStatus?: string;
    signalLevel?: number;
    appVersionName?: string;
    appBuildType?: string;
    createdAtMillis?: number;
  };

  let body: HeartbeatBody;
  try {
    body = await c.req.json<HeartbeatBody>();
  } catch {
    return c.json({ message: "Heartbeat body must be valid JSON." }, 400);
  }

  // Presence freshness must use server receive time. Device clocks are often
  // skewed; using createdAtMillis from the phone made rows look 2+ minutes old
  // on the admin map and caused pins to flash then vanish within ~1s.
  const receivedAt = Date.now();
  const clientCreatedAt =
    typeof body.createdAtMillis === "number" && Number.isFinite(body.createdAtMillis)
      ? body.createdAtMillis
      : receivedAt;

  const latitude =
    typeof body.latitude === "number" && Number.isFinite(body.latitude) ? body.latitude : null;
  const longitude =
    typeof body.longitude === "number" && Number.isFinite(body.longitude) ? body.longitude : null;
  const usableCoords =
    latitude != null &&
    longitude != null &&
    !(latitude === 0 && longitude === 0) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;

  db.prepare(
    `INSERT INTO heartbeats (
      company_id, driver_id, driver_device_id, vehicle_id, route_run_id, active_stop_id,
      latitude, longitude, battery_level_percent, network_status, speed_kmh,
      heading_degrees, route_status, signal_level, app_version_name,
      app_build_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    body.driverId ?? c.get("driverId"),
    body.driverDeviceId ?? c.get("driverDeviceId"),
    body.vehicleId ?? c.get("vehicleId"),
    body.routeRunId ?? "",
    body.activeStopId ?? "",
    usableCoords ? latitude : null,
    usableCoords ? longitude : null,
    body.batteryLevelPercent ?? null,
    body.networkStatus ?? "unknown",
    body.speedKmh ?? null,
    body.headingDegrees ?? null,
    body.routeStatus ?? "",
    body.signalLevel ?? null,
    body.appVersionName ?? "",
    body.appBuildType ?? "",
    receivedAt
  );

  // clientCreatedAt kept for diagnostics only (skew debugging).
  void clientCreatedAt;

  return c.json({ message: "Device heartbeat stored.", receivedAtMillis: receivedAt });
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
    Date.now()
  );

  const driverId = String(body.driverId ?? c.get("driverId") ?? "").trim();
  const stopId = String(body.stopId ?? "").trim();
  const stopStatus = String(body.stopStatus ?? "").trim();
  if (driverId && stopId && stopStatus) {
    applyStopProgressToLatestPlan(companyId, driverId, stopId, stopStatus);
  }

  return c.json({ message: "Route progress update stored." });
});

const LIVE_LOCATION_MAX_AGE_MS = 1000 * 60 * 30;
/** Admin live map: keep last good fix long enough for brief GPS/network gaps. */
const ADMIN_LIVE_PRESENCE_MAX_AGE_MS = 1000 * 60 * 10;

function latestHeartbeats(companyId: string, maxAgeMs = LIVE_LOCATION_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  return db
    .prepare(
      `SELECT h.company_id AS companyId, h.driver_id AS driverId, h.driver_device_id AS driverDeviceId,
              h.vehicle_id AS vehicleId, h.route_run_id AS routeRunId, h.active_stop_id AS activeStopId,
              h.latitude, h.longitude, h.battery_level_percent AS batteryLevelPercent,
              h.speed_kmh AS speedKmh, h.heading_degrees AS headingDegrees,
              h.route_status AS routeStatus, h.signal_level AS signalLevel,
              h.network_status AS networkStatus, h.app_version_name AS appVersionName,
              h.created_at AS createdAtMillis
       FROM heartbeats h
       INNER JOIN (
         SELECT driver_id, MAX(created_at) AS max_created
         FROM heartbeats
         WHERE company_id = ?
           AND created_at >= ?
           AND latitude IS NOT NULL
           AND longitude IS NOT NULL
           AND NOT (latitude = 0 AND longitude = 0)
         GROUP BY driver_id
       ) latest ON latest.driver_id = h.driver_id AND latest.max_created = h.created_at
       WHERE h.company_id = ?`
    )
    .all(companyId, cutoff, companyId) as Array<Record<string, unknown>>;
}

function latestProgressLocations(companyId: string, maxAgeMs = LIVE_LOCATION_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  return db
    .prepare(
      `SELECT p.company_id AS companyId, p.driver_id AS driverId, p.driver_device_id AS driverDeviceId,
              p.vehicle_id AS vehicleId, p.route_run_id AS routeRunId, p.stop_id AS activeStopId,
              p.latitude, p.longitude, NULL AS batteryLevelPercent,
              NULL AS speedKmh, NULL AS headingDegrees,
              '' AS routeStatus, NULL AS signalLevel,
              'route-progress' AS networkStatus, '' AS appVersionName,
              p.created_at AS createdAtMillis
       FROM route_progress p
       INNER JOIN (
         SELECT driver_id, MAX(created_at) AS max_created
         FROM route_progress
         WHERE company_id = ?
           AND created_at >= ?
           AND latitude IS NOT NULL
           AND longitude IS NOT NULL
           AND NOT (latitude = 0 AND longitude = 0)
         GROUP BY driver_id
       ) latest ON latest.driver_id = p.driver_id AND latest.max_created = p.created_at
       WHERE p.company_id = ?`
    )
    .all(companyId, cutoff, companyId) as Array<Record<string, unknown>>;
}

function mergeLatestLocations(
  heartbeats: Array<Record<string, unknown>>,
  progress: Array<Record<string, unknown>>,
) {
  const heartbeatByDriver = new Map<string, Record<string, unknown>>();
  const progressByDriver = new Map<string, Record<string, unknown>>();

  for (const row of heartbeats) {
    const driverId = String(row.driverId ?? "").trim();
    if (driverId) heartbeatByDriver.set(driverId, row);
  }

  for (const row of progress) {
    const driverId = String(row.driverId ?? "").trim();
    if (driverId) progressByDriver.set(driverId, row);
  }

  const merged: Array<Record<string, unknown>> = [];
  const driverIds = new Set([...heartbeatByDriver.keys(), ...progressByDriver.keys()]);

  for (const driverId of driverIds) {
    const heartbeat = heartbeatByDriver.get(driverId);
    const progressRow = progressByDriver.get(driverId);

    if (!heartbeat && progressRow) {
      merged.push({ ...progressRow });
      continue;
    }
    if (heartbeat && !progressRow) {
      merged.push({ ...heartbeat });
      continue;
    }
    if (!heartbeat || !progressRow) continue;

    const heartbeatTime = Number(heartbeat.createdAtMillis ?? 0);
    const progressTime = Number(progressRow.createdAtMillis ?? 0);
    const winner = heartbeatTime >= progressTime ? { ...heartbeat } : { ...progressRow };
    const other = heartbeatTime >= progressTime ? progressRow : heartbeat;
    const timeGapMs = Math.abs(heartbeatTime - progressTime);

    // Live map must match the driver GPS stream. Prefer heartbeat lat/lng whenever
    // the heartbeat has usable coordinates, even if a progress event is newer.
    const heartbeatLat = Number(heartbeat.latitude);
    const heartbeatLng = Number(heartbeat.longitude);
    const heartbeatHasGps =
      Number.isFinite(heartbeatLat) &&
      Number.isFinite(heartbeatLng) &&
      !(heartbeatLat === 0 && heartbeatLng === 0);
    if (heartbeatHasGps && timeGapMs <= 120_000) {
      winner.latitude = heartbeat.latitude;
      winner.longitude = heartbeat.longitude;
      if (heartbeat.speedKmh != null) winner.speedKmh = heartbeat.speedKmh;
      if (heartbeat.headingDegrees != null) winner.headingDegrees = heartbeat.headingDegrees;
    }

    if (winner.speedKmh == null && other.speedKmh != null) {
      winner.speedKmh = other.speedKmh;
    }
    if (!winner.headingDegrees && other.headingDegrees != null) {
      winner.headingDegrees = other.headingDegrees;
    }

    const winnerRouteStatus = String(winner.routeStatus ?? "").trim().toLowerCase();
    const otherRouteStatus = String(other.routeStatus ?? "").trim().toLowerCase();
    const winnerActive =
      Boolean(String(winner.routeRunId ?? "").trim()) ||
      (winnerRouteStatus !== "" && winnerRouteStatus !== "idle");
    const otherActive =
      Boolean(String(other.routeRunId ?? "").trim()) ||
      (otherRouteStatus !== "" && otherRouteStatus !== "idle");

    // Prefer an active heartbeat/progress route status over a blank/idle peer.
    if (!winnerActive && otherActive) {
      winner.routeStatus = other.routeStatus;
      if (!String(winner.routeRunId ?? "").trim() && String(other.routeRunId ?? "").trim()) {
        winner.routeRunId = other.routeRunId;
      }
      if (!String(winner.activeStopId ?? "").trim() && String(other.activeStopId ?? "").trim()) {
        winner.activeStopId = other.activeStopId;
      }
    } else {
      if (!String(winner.routeStatus ?? "").trim() && String(other.routeStatus ?? "").trim()) {
        winner.routeStatus = other.routeStatus;
      }
      if (!String(winner.routeRunId ?? "").trim() && String(other.routeRunId ?? "").trim()) {
        winner.routeRunId = other.routeRunId;
      }
      if (!String(winner.activeStopId ?? "").trim() && String(other.activeStopId ?? "").trim()) {
        winner.activeStopId = other.activeStopId;
      }
    }

    if (winner.batteryLevelPercent == null && other.batteryLevelPercent != null) {
      winner.batteryLevelPercent = other.batteryLevelPercent;
    }

    // Route progress often wins on timestamp but drops speed — keep recent heartbeat motion fields.
    if (
      winner.speedKmh == null &&
      heartbeat.speedKmh != null &&
      timeGapMs <= 120_000
    ) {
      winner.speedKmh = heartbeat.speedKmh;
      if (winner.headingDegrees == null && heartbeat.headingDegrees != null) {
        winner.headingDegrees = heartbeat.headingDegrees;
      }
      if (!String(winner.routeStatus ?? "").trim() && String(heartbeat.routeStatus ?? "").trim()) {
        winner.routeStatus = heartbeat.routeStatus;
      }
    }

    merged.push(winner);
  }

  return merged;
}

function latestDriverLocations(companyId: string, maxAgeMs = LIVE_LOCATION_MAX_AGE_MS) {
  return mergeLatestLocations(
    latestHeartbeats(companyId, maxAgeMs),
    latestProgressLocations(companyId, maxAgeMs),
  );
}

function scopedDriverLocations(
  companyId: string,
  admin: import("../lib/admin-auth.js").AdminIdentity | undefined,
  maxAgeMs = LIVE_LOCATION_MAX_AGE_MS,
) {
  const locations = latestDriverLocations(companyId, maxAgeMs);
  return filterRowsByAccessibleDrivers(locations, companyId, admin);
}

companyRoutes.get("/route47/companies/:companyId/admin/live-locations", (c) => {
  const companyId = c.req.param("companyId");
  const locations = scopedDriverLocations(
    companyId,
    c.get("admin"),
    ADMIN_LIVE_PRESENCE_MAX_AGE_MS,
  );

  return c.json({
    message: `${locations.length} live location(s).`,
    locations,
    liveLocations: locations,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/live-updates", (c) => {
  const companyId = c.req.param("companyId");
  const locations = scopedDriverLocations(
    companyId,
    c.get("admin"),
    ADMIN_LIVE_PRESENCE_MAX_AGE_MS,
  );

  return c.json({
    message: `${locations.length} live update(s).`,
    updates: locations,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.get("/route47/companies/:companyId/devices/locations", (c) => {
  const companyId = c.req.param("companyId");
  const sessionDriverId = c.get("driverId")?.trim() ?? "";
  let locations = latestDriverLocations(companyId);
  if (sessionDriverId) {
    locations = locations.filter((row) => String(row.driverId ?? "").trim() === sessionDriverId);
  } else {
    locations = scopedDriverLocations(companyId, c.get("admin"));
  }

  return c.json({
    message: `${locations.length} device location(s).`,
    devices: locations,
    serverTimeMillis: Date.now(),
  });
});

companyRoutes.post("/route47/companies/:companyId/sync/request", async (c) => {
  const companyId = c.req.param("companyId");
  let parsedBody: { syncTypes?: string[]; driverId?: string; routeRunId?: string } = { syncTypes: [] };
  try {
    parsedBody = await c.req.json<{ syncTypes?: string[]; driverId?: string; routeRunId?: string }>();
  } catch {
    parsedBody = { syncTypes: [] };
  }
  const syncTypes = parsedBody.syncTypes ?? [];
  const driverId = parsedBody.driverId?.trim() || c.get("driverId")?.trim() || "";

  if (driverId) {
    const { notifySilentSync } = await import("../lib/route-notification-hooks.js");
    notifySilentSync(companyId, driverId, parsedBody.routeRunId?.trim() ?? "");
  }

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

  const stopSummary = summarizeRoutePlanStops(companyId, driverId, routeRunId);

  db.prepare(
    `INSERT INTO daily_reports (
      report_id, company_id, driver_id, driver_device_id, vehicle_id, route_run_id,
      route_date_iso, total_stops, completed_stops, skipped_stops, failed_stops,
      proof_count, receipt_count, total_distance_meters, total_drive_time_seconds,
      delivery_stops, pickup_stops, customer_deliveries_json,
      created_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      delivery_stops = excluded.delivery_stops,
      pickup_stops = excluded.pickup_stops,
      customer_deliveries_json = excluded.customer_deliveries_json,
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
    stopSummary.deliveryStops,
    stopSummary.pickupStops,
    JSON.stringify(stopSummary.customerDeliveries),
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
              delivery_stops, pickup_stops, customer_deliveries_json,
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
