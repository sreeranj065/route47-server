import { db, type RoutePlanRow } from "../db.js";

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
): { completed: number; total: number } {
  if (!plan) return { completed: 0, total: 0 };
  try {
    const stops = JSON.parse(plan.stops_json || "[]") as Array<{
      stopId?: string;
      status?: string;
      stopStatus?: string;
      notes?: string;
    }>;
    const total = stops.length;
    if (total === 0) return { completed: 0, total: 0 };

    const progressByStop = latestProgressByStop(companyId, driverId, plan.route_run_id);
    let completed = 0;
    for (const stop of stops) {
      const stopId = String(stop.stopId ?? "").trim();
      const fromProgress = stopId ? progressByStop.get(stopId) : undefined;
      const status = fromProgress || readStopStatusFromJson(stop);
      if (status === "Completed") completed++;
    }
    return { completed, total };
  } catch {
    return { completed: 0, total: 0 };
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

    const allCompleted = stops.every(
      (stop) => readStopStatusFromJson(stop as { stopStatus?: string; status?: string; notes?: string }) === "Completed",
    );
    const now = Date.now();
    db.prepare(
      `UPDATE route_plans
       SET stops_json = ?, status = ?, updated_at = ?
       WHERE company_id = ? AND route_run_id = ?`,
    ).run(
      JSON.stringify(stops),
      allCompleted ? "completed" : "in_progress",
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
  const { completed, total } = stopProgress(companyId, driverId, plan);
  if (total > 0 && completed >= total) return "Offline";

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
