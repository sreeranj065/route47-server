import { isValidAdminKey } from "../auth.js";
import { companyRoutes } from "./auth.js";
import { db } from "../db.js";

function readAdminKey(c: { req: { header: (name: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return c.req.header("X-Route47-Admin-Key")?.trim() ?? bearer;
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  return isValidAdminKey(readAdminKey(c));
}

function proofTypeToEventType(proofType: string): string {
  const normalized = proofType.toLowerCase();
  if (normalized.includes("receipt")) return "RECEIPT_UPLOADED";
  if (normalized.includes("photo")) return "PHOTO_UPLOADED";
  if (normalized.includes("signature")) return "SIGNATURE_UPLOADED";
  if (normalized.includes("pod") || normalized.includes("delivery")) return "POD_UPLOADED";
  return "DOCUMENT_UPLOADED";
}

function normalizeStopStatus(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === "completed") return "Completed";
  if (lower === "skipped") return "Skipped";
  if (lower === "failed") return "Failed";
  if (lower === "arrived") return "Arrived";
  if (lower === "active") return "Active";
  if (lower === "pending") return "Pending";
  return value;
}

function normalizeProgressEventType(eventType: string, stopStatus: string): string {
  const trimmed = eventType.trim();
  if (trimmed) return trimmed;
  const normalized = normalizeStopStatus(stopStatus);
  if (normalized === "Completed") return "STOP_COMPLETED";
  if (normalized === "Skipped") return "STOP_SKIPPED";
  if (normalized === "Failed") return "STOP_FAILED";
  if (normalized === "Arrived") return "STOP_ARRIVED";
  return "ROUTE_PROGRESS";
}

companyRoutes.post("/route47/companies/:companyId/activity/sync", async (c) => {
  const companyId = c.req.param("companyId");
  const sessionDriverId = c.get("driverId")?.trim() ?? "";

  const body = await c.req.json<{
    events?: Array<{
      eventId?: string;
      driverId?: string;
      companyId?: string;
      routeId?: string;
      stopId?: string;
      eventType?: string;
      timestampMillis?: number;
      latitude?: number;
      longitude?: number;
      metadata?: Record<string, string>;
    }>;
  }>();

  const events = body.events ?? [];
  if (events.length === 0) {
    return c.json({ message: "No activity events to sync." });
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO activity_events (
      event_id, company_id, driver_id, route_id, stop_id, event_type,
      timestamp_millis, latitude, longitude, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  let synced = 0;

  for (const event of events) {
    const eventId = event.eventId?.trim();
    if (!eventId) continue;

    const driverId = event.driverId?.trim() || sessionDriverId;
    if (!driverId) continue;

    const driver = db
      .prepare(`SELECT id FROM drivers WHERE company_id = ? AND id = ?`)
      .get(companyId, driverId);
    if (!driver) continue;

    insert.run(
      eventId,
      companyId,
      driverId,
      event.routeId?.trim() ?? "",
      event.stopId?.trim() ?? "",
      event.eventType?.trim() ?? "UNKNOWN",
      Number(event.timestampMillis) || now,
      typeof event.latitude === "number" ? event.latitude : null,
      typeof event.longitude === "number" ? event.longitude : null,
      JSON.stringify(event.metadata ?? {}),
      now,
    );
    synced += 1;
  }

  return c.json({
    message: `${synced} activity event(s) synced.`,
    syncedCount: synced,
  });
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

  const activityRows = db
    .prepare(
      `SELECT event_id AS eventId, driver_id AS driverId, route_id AS routeId, stop_id AS stopId,
              event_type AS eventType, timestamp_millis AS timestampMillis,
              latitude, longitude, metadata_json AS metadataJson
       FROM activity_events
       WHERE company_id = ? AND driver_id = ?
       ${routeId ? "AND route_id = ?" : ""}
       ${stopId ? "AND stop_id = ?" : ""}
       ${fromMillis ? "AND timestamp_millis >= ?" : ""}
       ${toMillis ? "AND timestamp_millis <= ?" : ""}
       ORDER BY timestamp_millis DESC
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

  const syncedEvents = activityRows.map((row) => {
    let metadata: Record<string, string> = {};
    try {
      metadata = JSON.parse(String(row.metadataJson ?? "{}")) as Record<string, string>;
    } catch {
      metadata = {};
    }

    return {
      eventId: String(row.eventId ?? ""),
      driverId,
      companyId,
      routeId: row.routeId,
      stopId: row.stopId,
      eventType: String(row.eventType ?? ""),
      timestampMillis: row.timestampMillis,
      latitude: row.latitude,
      longitude: row.longitude,
      metadata,
    };
  });

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

  let events = [...syncedEvents, ...progressEvents, ...proofEvents].sort(
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
