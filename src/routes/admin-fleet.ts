import { DEMO_SERVER } from "../config.js";
import { companyRoutes } from "./auth.js";
import { db, routePlanToJson, type RoutePlanRow } from "../db.js";

function readAdminKey(c: { req: { header: (name: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return c.req.header("X-Route47-Admin-Key")?.trim() ?? bearer;
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  const expected = process.env.ROUTE47_ADMIN_API_KEY ?? DEMO_SERVER.defaultAdminApiKey;
  const provided = readAdminKey(c);
  return !!provided && provided === expected;
}

type DriverRow = {
  id: string;
  displayName: string;
  username: string;
  vehicleId: string;
};

function latestRoutePlan(companyId: string, driverId: string): RoutePlanRow | undefined {
  return db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ? AND driver_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(companyId, driverId) as RoutePlanRow | undefined;
}

function driverStatus(companyId: string, driverId: string): string {
  const cutoff = Date.now() - 1000 * 60 * 15;
  const heartbeat = db
    .prepare(
      `SELECT created_at AS createdAt
       FROM heartbeats
       WHERE company_id = ? AND driver_id = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(companyId, driverId, cutoff) as { createdAt: number } | undefined;

  if (heartbeat) return "On Route";

  const delayed = db
    .prepare(
      `SELECT stop_status AS stopStatus
       FROM route_progress
       WHERE company_id = ? AND driver_id = ? AND stop_status = 'Delayed'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(companyId, driverId) as { stopStatus: string } | undefined;

  if (delayed) return "Delayed";
  return "Offline";
}

function stopProgress(plan: RoutePlanRow | undefined): { completed: number; total: number } {
  if (!plan) return { completed: 0, total: 0 };
  try {
    const stops = JSON.parse(plan.stops_json || "[]") as Array<{ status?: string; notes?: string }>;
    const total = stops.length;
    const completed = stops.filter((stop) => {
      const status = stop.status ?? (stop.notes?.startsWith("Status: ") ? stop.notes.slice(8) : "");
      return status === "Completed";
    }).length;
    return { completed, total };
  } catch {
    return { completed: 0, total: 0 };
  }
}

function mapDriverRecord(companyId: string, row: DriverRow, index: number) {
  const plan = latestRoutePlan(companyId, row.id);
  const { completed, total } = stopProgress(plan);
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    driverId: row.id,
    id: row.id,
    name: row.displayName || row.username || "Driver",
    username: row.username,
    status: driverStatus(companyId, row.id),
    vehicleId: row.vehicleId || plan?.vehicle_id || "",
    routeId: plan?.route_run_id || `RT-${100 + index}`,
    completedStops: completed,
    totalStops: total,
    completed,
    total,
    progress,
    progressPercent: progress,
  };
}

function proofTypeToEventType(proofType: string): string {
  const normalized = proofType.toLowerCase();
  if (normalized.includes("receipt")) return "RECEIPT_UPLOADED";
  if (normalized.includes("photo")) return "PHOTO_UPLOADED";
  if (normalized.includes("signature")) return "SIGNATURE_UPLOADED";
  if (normalized.includes("pod") || normalized.includes("delivery")) return "POD_UPLOADED";
  return "DOCUMENT_UPLOADED";
}

function normalizeProgressEventType(eventType: string, stopStatus: string): string {
  const trimmed = eventType.trim();
  if (trimmed) return trimmed;
  if (stopStatus === "Completed") return "STOP_COMPLETED";
  if (stopStatus === "Skipped") return "STOP_SKIPPED";
  if (stopStatus === "Failed") return "STOP_FAILED";
  if (stopStatus === "Arrived") return "STOP_ARRIVED";
  return "ROUTE_PROGRESS";
}

companyRoutes.get("/route47/companies/:companyId/drivers", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const rows = db
    .prepare(
      `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId
       FROM drivers
       WHERE company_id = ?
       ORDER BY display_name ASC, username ASC`,
    )
    .all(companyId) as DriverRow[];

  return c.json({
    message: `${rows.length} driver(s).`,
    drivers: rows.map((row, index) => mapDriverRecord(companyId, row, index)),
  });
});

companyRoutes.get("/route47/companies/:companyId/drivers/:driverId", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const driverId = c.req.param("driverId");

  const row = db
    .prepare(
      `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId
       FROM drivers
       WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, driverId) as DriverRow | undefined;

  if (!row) {
    return c.json({ message: "Driver not found." }, 404);
  }

  return c.json(mapDriverRecord(companyId, row, 0));
});

companyRoutes.patch("/route47/companies/:companyId/drivers/:driverId/status", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const driverId = c.req.param("driverId");
  const body = await c.req.json<{ status?: string }>().catch(() => ({ status: "" }));

  const row = db
    .prepare(
      `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId
       FROM drivers
       WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, driverId) as DriverRow | undefined;

  if (!row) {
    return c.json({ message: "Driver not found." }, 404);
  }

  // Status is derived from live heartbeats/progress; accept the override for UI
  // but reflect it in the response only (no separate status column yet).
  const status = body.status?.trim() || driverStatus(companyId, driverId);
  const mapped = mapDriverRecord(companyId, row, 0);
  return c.json({ ...mapped, status });
});

companyRoutes.get("/route47/companies/:companyId/drivers/:driverId/current-list", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const driverId = c.req.param("driverId");

  const driver = db
    .prepare(`SELECT id FROM drivers WHERE company_id = ? AND id = ?`)
    .get(companyId, driverId);

  if (!driver) {
    return c.json({ message: "Driver not found." }, 404);
  }

  const plan = latestRoutePlan(companyId, driverId);
  if (!plan) {
    return c.json({ message: "No current list published for this driver." }, 404);
  }

  return c.json(routePlanToJson(plan));
});

companyRoutes.get("/route47/companies/:companyId/drivers/:driverId/activity", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const driverId = c.req.param("driverId");
  const eventType = c.req.query("eventType")?.trim();
  const routeId = c.req.query("routeId")?.trim();
  const stopId = c.req.query("stopId")?.trim();
  const fromMillis = Number(c.req.query("fromMillis") || 0);
  const toMillis = Number(c.req.query("toMillis") || 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 50), 1), 500);

  const driver = db
    .prepare(`SELECT id FROM drivers WHERE company_id = ? AND id = ?`)
    .get(companyId, driverId);

  if (!driver) {
    return c.json({ message: "Driver not found." }, 404);
  }

  const progressRows = db
    .prepare(
      `SELECT id, route_run_id AS routeRunId, stop_id AS stopId, stop_status AS stopStatus,
              event_type AS eventType, message, latitude, longitude, created_at AS createdAtMillis
       FROM route_progress
       WHERE company_id = ? AND driver_id = ?
       ${routeId ? "AND route_run_id = ?" : ""}
       ${stopId ? "AND stop_id = ?" : ""}
       ${fromMillis ? "AND created_at >= ?" : ""}
       ${toMillis ? "AND created_at <= ?" : ""}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(
      ...[
        companyId,
        driverId,
        ...(routeId ? [routeId] : []),
        ...(stopId ? [stopId] : []),
        ...(fromMillis ? [fromMillis] : []),
        ...(toMillis ? [toMillis] : []),
        limit,
      ],
    ) as Array<Record<string, unknown>>;

  const proofRows = db
    .prepare(
      `SELECT proof_id AS proofId, route_run_id AS routeRunId, stop_id AS stopId,
              proof_type AS proofType, customer_name AS customerName, address,
              created_at AS createdAtMillis
       FROM proofs
       WHERE company_id = ? AND driver_id = ?
       ${routeId ? "AND route_run_id = ?" : ""}
       ${stopId ? "AND stop_id = ?" : ""}
       ${fromMillis ? "AND created_at >= ?" : ""}
       ${toMillis ? "AND created_at <= ?" : ""}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(
      ...[
        companyId,
        driverId,
        ...(routeId ? [routeId] : []),
        ...(stopId ? [stopId] : []),
        ...(fromMillis ? [fromMillis] : []),
        ...(toMillis ? [toMillis] : []),
        limit,
      ],
    ) as Array<Record<string, unknown>>;

  const progressEvents = progressRows.map((row) => {
    const eventTypeValue = normalizeProgressEventType(
      String(row.eventType ?? ""),
      String(row.stopStatus ?? ""),
    );
    return {
      eventId: `progress-${row.id}`,
      driverId,
      companyId,
      routeId: row.routeRunId,
      stopId: row.stopId,
      eventType: eventTypeValue,
      timestampMillis: row.createdAtMillis,
      latitude: row.latitude,
      longitude: row.longitude,
      metadata: {
        message: String(row.message ?? ""),
        stopStatus: String(row.stopStatus ?? ""),
      },
    };
  });

  const proofEvents = proofRows.map((row) => ({
    eventId: `proof-${row.proofId}`,
    driverId,
    companyId,
    routeId: row.routeRunId,
    stopId: row.stopId,
    eventType: proofTypeToEventType(String(row.proofType ?? "")),
    timestampMillis: row.createdAtMillis,
    metadata: {
      proofId: String(row.proofId ?? ""),
      customerName: String(row.customerName ?? ""),
      address: String(row.address ?? ""),
    },
  }));

  let events = [...progressEvents, ...proofEvents].sort(
    (a, b) => Number(b.timestampMillis) - Number(a.timestampMillis),
  );

  if (eventType) {
    events = events.filter((event) => String(event.eventType).includes(eventType));
  }

  return c.json({
    message: `${events.length} activity event(s).`,
    events: events.slice(0, limit),
  });
});
