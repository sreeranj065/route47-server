import { db, type RoutePlanRow } from "../db.js";

/** One route plan row per driver per calendar day — matches the driver app format. */
export function canonicalRouteRunId(driverId: string, routeDateIso?: string): string {
  const safeDriver = driverId.trim() || "driver";
  const date = (routeDateIso ?? new Date().toISOString().slice(0, 10)).trim();
  return `run-${safeDriver}-${date}`;
}

export function mergeRoutePlanStops(
  existing: unknown[],
  incoming: unknown[],
  incomingWinsOnConflict: boolean,
): unknown[] {
  const stopIdOf = (stop: unknown): string =>
    String((stop as Record<string, unknown>).stopId ?? "").trim();

  const existingIds = new Set(existing.map(stopIdOf).filter(Boolean));
  const incomingIds = new Set(incoming.map(stopIdOf).filter(Boolean));
  const hasNewStops = [...incomingIds].some((id) => !existingIds.has(id));
  const hasRemovals = [...existingIds].some((id) => !incomingIds.has(id));

  // Admin sends the full current list. Pure deletes (subset, no new ids) must drop
  // removed stops — the old merge-only logic kept them forever.
  if (incomingWinsOnConflict && hasRemovals && !hasNewStops) {
    return applyIncomingStops(existing, incoming);
  }

  // Adds/updates with a complete list, or first publish with no prior stops.
  if (incomingWinsOnConflict && !hasRemovals) {
    return applyIncomingStops(existing, incoming);
  }

  // Race: new stop(s) plus missing prior ids — keep orphans from existing.
  const byId = new Map<string, Record<string, unknown>>();

  for (const stop of existing) {
    const record = stop as Record<string, unknown>;
    const id = stopIdOf(stop);
    if (id) byId.set(id, record);
  }

  for (const stop of incoming) {
    const record = stop as Record<string, unknown>;
    const id = stopIdOf(stop);
    if (!id) continue;
    if (!byId.has(id) || incomingWinsOnConflict) {
      byId.set(id, record);
    }
  }

  const result: unknown[] = [];
  const seen = new Set<string>();

  for (const stop of existing) {
    const id = stopIdOf(stop);
    if (id && byId.has(id) && !seen.has(id)) {
      result.push(byId.get(id));
      seen.add(id);
    }
  }

  for (const stop of incoming) {
    const id = stopIdOf(stop);
    if (id && !seen.has(id)) {
      result.push(byId.get(id) ?? stop);
      seen.add(id);
    }
  }

  return result;
}

function applyIncomingStops(existing: unknown[], incoming: unknown[]): unknown[] {
  const stopIdOf = (stop: unknown): string =>
    String((stop as Record<string, unknown>).stopId ?? "").trim();
  const existingById = new Map<string, Record<string, unknown>>();
  for (const stop of existing) {
    const id = stopIdOf(stop);
    if (id) existingById.set(id, stop as Record<string, unknown>);
  }

  return incoming.map((stop) => {
    const id = stopIdOf(stop);
    const previous = id ? existingById.get(id) : undefined;
    return previous ? { ...previous, ...(stop as Record<string, unknown>) } : stop;
  });
}

export function deleteDuplicateRoutePlansForDriverDay(
  companyId: string,
  driverId: string,
  routeDateIso: string,
  keepRouteRunId: string,
): void {
  const safeDriver = driverId.trim();
  if (!safeDriver) return;

  db.prepare(
    `DELETE FROM route_plans
     WHERE company_id = ? AND driver_id = ? AND route_date_iso = ? AND route_run_id != ?`,
  ).run(companyId, safeDriver, routeDateIso, keepRouteRunId);
}

export function normalizeStopStatus(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === "completed") return "Completed";
  if (lower === "skipped") return "Skipped";
  if (lower === "failed") return "Failed";
  if (lower === "arrived") return "Arrived";
  if (lower === "active") return "Active";
  if (lower === "pending") return "Pending";
  if (lower === "delayed") return "Delayed";
  return value;
}

const TERMINAL_STOP_STATUSES = new Set(["Completed", "Failed", "Skipped"]);

export function isTerminalStopStatus(raw: string | undefined): boolean {
  const normalized = normalizeStopStatus(raw);
  return TERMINAL_STOP_STATUSES.has(normalized);
}

export function readStopStatusFromJson(stop: {
  status?: string;
  stopStatus?: string;
  notes?: string;
}): string {
  const fromNotes = stop.notes?.startsWith("Status: ") ? stop.notes.slice(8) : "";
  return normalizeStopStatus(stop.stopStatus ?? stop.status ?? fromNotes);
}

export function latestRoutePlan(companyId: string, driverId: string): RoutePlanRow | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const canonicalId = canonicalRouteRunId(driverId, today);

  const canonicalPlan = db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ? AND route_run_id = ?`,
    )
    .get(companyId, canonicalId) as RoutePlanRow | undefined;

  if (canonicalPlan) return canonicalPlan;

  return db
    .prepare(
      `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
       FROM route_plans
       WHERE company_id = ? AND driver_id = ?
       ORDER BY (route_date_iso = ?) DESC, updated_at DESC
       LIMIT 1`,
    )
    .get(companyId, driverId, today) as RoutePlanRow | undefined;
}

export function latestProgressByStop(
  companyId: string,
  driverId: string,
  routeRunId: string,
): Map<string, string> {
  const map = new Map<string, string>();

  const exactRows = db
    .prepare(
      `SELECT stop_id AS stopId, stop_status AS stopStatus
       FROM route_progress
       WHERE company_id = ? AND driver_id = ? AND route_run_id = ?
       ORDER BY created_at DESC`,
    )
    .all(companyId, driverId, routeRunId) as Array<{ stopId: string; stopStatus: string }>;

  for (const row of exactRows) {
    const stopId = String(row.stopId ?? "").trim();
    if (!stopId || map.has(stopId)) continue;
    map.set(stopId, normalizeStopStatus(row.stopStatus));
  }

  if (map.size > 0) return map;

  const fallbackRows = db
    .prepare(
      `SELECT stop_id AS stopId, stop_status AS stopStatus
       FROM route_progress
       WHERE company_id = ? AND driver_id = ?
       ORDER BY created_at DESC`,
    )
    .all(companyId, driverId) as Array<{ stopId: string; stopStatus: string }>;

  for (const row of fallbackRows) {
    const stopId = String(row.stopId ?? "").trim();
    if (!stopId || map.has(stopId)) continue;
    map.set(stopId, normalizeStopStatus(row.stopStatus));
  }

  return map;
}

export function stopProgress(
  companyId: string,
  driverId: string,
  plan: RoutePlanRow | undefined,
): { completed: number; terminal: number; total: number } {
  if (!plan) return { completed: 0, terminal: 0, total: 0 };
  try {
    const stops = JSON.parse(plan.stops_json || "[]") as Array<{
      stopId?: string;
      status?: string;
      stopStatus?: string;
      notes?: string;
    }>;
    const total = stops.length;
    if (total === 0) return { completed: 0, terminal: 0, total: 0 };

    const progressByStop = latestProgressByStop(companyId, driverId, plan.route_run_id);
    let completed = 0;
    let terminal = 0;
    for (const stop of stops) {
      const stopId = String(stop.stopId ?? "").trim();
      const fromProgress = stopId ? progressByStop.get(stopId) : undefined;
      const status = fromProgress || readStopStatusFromJson(stop);
      if (status === "Completed") completed++;
      if (isTerminalStopStatus(status)) terminal++;
    }
    return { completed, terminal, total };
  } catch {
    return { completed: 0, terminal: 0, total: 0 };
  }
}

export function applyStopProgressToLatestPlan(
  companyId: string,
  driverId: string,
  stopId: string,
  stopStatus: string,
): void {
  const safeStopId = stopId.trim();
  if (!safeStopId) return;

  const plan = latestRoutePlan(companyId, driverId);
  if (!plan) return;

  const normalized = normalizeStopStatus(stopStatus);
  if (!normalized) return;

  try {
    const stops = JSON.parse(plan.stops_json || "[]") as Array<Record<string, unknown>>;
    let changed = false;

    for (const stop of stops) {
      if (String(stop.stopId ?? "").trim() !== safeStopId) continue;
      stop.stopStatus = normalized;
      changed = true;
      break;
    }

    if (!changed) return;

    const allTerminal = stops.every((stop) =>
      isTerminalStopStatus(
        readStopStatusFromJson(stop as { stopStatus?: string; status?: string; notes?: string }),
      ),
    );
    const now = Date.now();
    db.prepare(
      `UPDATE route_plans
       SET stops_json = ?, status = ?, updated_at = ?
       WHERE company_id = ? AND route_run_id = ?`,
    ).run(
      JSON.stringify(stops),
      allTerminal ? "completed" : "in_progress",
      now,
      companyId,
      plan.route_run_id,
    );
  } catch {
    // Best-effort: route_progress row still records the event.
  }
}

export function driverStatus(companyId: string, driverId: string): string {
  const plan = latestRoutePlan(companyId, driverId);
  const { completed, terminal, total } = stopProgress(companyId, driverId, plan);

  // No stops on the published current list — driver is not running an admin route.
  if (total === 0) return "Offline";

  // Route finished when every stop reached a final state (Completed, Failed, or Skipped).
  if (terminal >= total) return "Offline";

  // Legacy: all stops marked Completed in plan JSON without terminal mix.
  if (completed >= total) return "Offline";

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

export type RoutePlanStopSummary = {
  customerDeliveries: Record<string, number>;
  deliveryStops: number;
  pickupStops: number;
  completedDeliveries: number;
};

function routePlanForReport(
  companyId: string,
  driverId: string,
  routeRunId: string,
): RoutePlanRow | undefined {
  if (routeRunId) {
    const exact = db
      .prepare(
        `SELECT route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
         FROM route_plans
         WHERE company_id = ? AND route_run_id = ?`,
      )
      .get(companyId, routeRunId) as RoutePlanRow | undefined;
    if (exact) return exact;
  }

  if (driverId) {
    return latestRoutePlan(companyId, driverId);
  }

  return undefined;
}

export function summarizeRoutePlanStops(
  companyId: string,
  driverId: string,
  routeRunId: string,
): RoutePlanStopSummary {
  const plan = routePlanForReport(companyId, driverId, routeRunId);
  if (!plan) {
    return {
      customerDeliveries: {},
      deliveryStops: 0,
      pickupStops: 0,
      completedDeliveries: 0,
    };
  }

  try {
    const stops = JSON.parse(plan.stops_json || "[]") as Array<{
      stopId?: string;
      stopType?: string;
      customerName?: string;
      status?: string;
      stopStatus?: string;
      notes?: string;
    }>;
    const progressByStop = latestProgressByStop(companyId, driverId, plan.route_run_id);
    const customerDeliveries: Record<string, number> = {};
    let deliveryStops = 0;
    let pickupStops = 0;
    let completedDeliveries = 0;

    for (const stop of stops) {
      const stopType = String(stop.stopType ?? "Delivery").trim().toLowerCase();
      const stopId = String(stop.stopId ?? "").trim();
      const fromProgress = stopId ? progressByStop.get(stopId) : undefined;
      const status = fromProgress || readStopStatusFromJson(stop);
      const isDelivery = stopType === "delivery" || stopType === "";
      const isPickup = stopType === "pickup";

      if (isPickup) pickupStops++;
      else if (isDelivery) deliveryStops++;

      if (isDelivery && status === "Completed") {
        completedDeliveries++;
        const customer = String(stop.customerName ?? "").trim() || "Unknown";
        customerDeliveries[customer] = (customerDeliveries[customer] ?? 0) + 1;
      }
    }

    return { customerDeliveries, deliveryStops, pickupStops, completedDeliveries };
  } catch {
    return {
      customerDeliveries: {},
      deliveryStops: 0,
      pickupStops: 0,
      completedDeliveries: 0,
    };
  }
}
