import crypto from "node:crypto";
import type { Hono } from "hono";
import { hashPassword } from "../auth.js";
import { DEMO_SERVER } from "../config.js";
import { db, routePlanToJson, type RoutePlanRow } from "../db.js";

type DriverRow = {
  id: string;
  displayName: string;
  username: string;
  vehicleId: string;
};

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

/** Admin driver roster — registered from auth.ts so it ships with core server routes. */
export function registerDriverAdminRoutes(companyRoutes: Hono<any>) {
  companyRoutes.post("/route47/companies/:companyId/drivers", async (c) => {
    if (!requireAdmin(c)) {
      return c.json({ message: "Admin API key required." }, 401);
    }

    const companyId = c.req.param("companyId");
    const body = await c.req.json<{
      id?: string;
      name?: string;
      phone?: string;
      vehicleId?: string;
      username?: string;
      password?: string;
    }>();

    const company = db.prepare(`SELECT id FROM companies WHERE id = ?`).get(companyId);
    if (!company) {
      return c.json({ message: "Company not found." }, 404);
    }

    const displayName = body.name?.trim() || "New Driver";
    const vehicleId = body.vehicleId?.trim() ?? "";
    const requestedId = body.id?.trim() ?? "";
    const driverId = requestedId || `drv-${crypto.randomBytes(4).toString("hex")}`;

    const existing = db
      .prepare(`SELECT id FROM drivers WHERE company_id = ? AND id = ?`)
      .get(companyId, driverId);
    if (existing) {
      return c.json({ message: "Driver ID already exists." }, 409);
    }

    const usernameBase =
      (body.username?.trim() || displayName.toLowerCase().replace(/[^a-z0-9]+/g, "."))
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 24) || "driver";
    let username = usernameBase;
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = db
        .prepare(`SELECT id FROM drivers WHERE company_id = ? AND username = ?`)
        .get(companyId, username);
      if (!taken) break;
      username = `${usernameBase}${attempt + 1}`.slice(0, 32);
    }

    const password = body.password?.trim() || crypto.randomBytes(6).toString("hex");
    const now = Date.now();

    db.prepare(
      `INSERT INTO drivers (id, company_id, username, password_hash, display_name, vehicle_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(driverId, companyId, username, hashPassword(password), displayName, vehicleId, now);

    const row = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId
         FROM drivers WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, driverId) as DriverRow;

    return c.json({
      ...mapDriverRecord(companyId, row, 0),
      username,
      phone: body.phone?.trim() ?? "",
      temporaryPassword: password,
      message: "Driver created.",
    });
  });

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
}
