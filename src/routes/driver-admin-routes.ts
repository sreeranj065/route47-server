import crypto from "node:crypto";
import fs from "node:fs";
import type { Hono } from "hono";
import { hashPassword } from "../auth.js";
import type { AdminIdentity } from "../lib/admin-auth.js";
import {
  adminCanAccessDriver,
  listAccessibleDriverIds,
  resolveDriverBranchId,
} from "../lib/branch-filter.js";
import { hasAdminAccess } from "../lib/route-admin.js";
import { db, routePlanToJson, type RoutePlanRow } from "../db.js";
import {
  driverStatus as computeDriverStatus,
  latestRoutePlan,
  stopProgress,
} from "../lib/route-plan-sync.js";

type DriverRow = {
  id: string;
  displayName: string;
  username: string;
  vehicleId: string;
  branchId: string;
  loginPassword?: string;
};

type DriverPatchBody = {
  name?: string;
  phone?: string;
  vehicleId?: string;
  username?: string;
  password?: string;
  branchId?: string;
};

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

function requireAdmin(c: { get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined }) {
  return hasAdminAccess(c);
}

function driverStatus(companyId: string, driverId: string): string {
  return computeDriverStatus(companyId, driverId);
}

function mapDriverRecord(companyId: string, row: DriverRow, index: number) {
  const plan = latestRoutePlan(companyId, row.id);
  const { completed, total } = stopProgress(companyId, row.id, plan);
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    driverId: row.id,
    id: row.id,
    name: row.displayName || row.username || "Driver",
    username: row.username,
    password: row.loginPassword || undefined,
    status: driverStatus(companyId, row.id),
    vehicleId: row.vehicleId || plan?.vehicle_id || "",
    branchId: row.branchId || "",
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
    const admin = getAdmin(c);
    const body = await c.req.json<{
      id?: string;
      name?: string;
      phone?: string;
      vehicleId?: string;
      username?: string;
      password?: string;
      branchId?: string;
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
    const branchId = resolveDriverBranchId(companyId, body.branchId);
    const now = Date.now();

    db.prepare(
      `INSERT INTO drivers (id, company_id, username, password_hash, login_password, display_name, vehicle_id, branch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      driverId,
      companyId,
      username,
      hashPassword(password),
      password,
      displayName,
      vehicleId,
      branchId,
      now,
    );

    const row = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId,
                login_password AS loginPassword
         FROM drivers WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, driverId) as DriverRow;

    return c.json({
      ...mapDriverRecord(companyId, row, 0),
      username,
      password,
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
    const admin = getAdmin(c);
    const accessibleIds = listAccessibleDriverIds(companyId, admin);
    const rows = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId,
                login_password AS loginPassword
         FROM drivers
         WHERE company_id = ?
         ORDER BY display_name ASC, username ASC`,
      )
      .all(companyId) as DriverRow[];

    const filtered =
      accessibleIds === null ? rows : rows.filter((row) => accessibleIds.includes(row.id));

    return c.json({
      message: `${filtered.length} driver(s).`,
      drivers: filtered.map((row, index) => mapDriverRecord(companyId, row, index)),
    });
  });

  companyRoutes.get("/route47/companies/:companyId/drivers/:driverId", (c) => {
    if (!requireAdmin(c)) {
      return c.json({ message: "Admin API key required." }, 401);
    }

    const companyId = c.req.param("companyId");
    const driverId = c.req.param("driverId");
    const admin = getAdmin(c);

    if (!adminCanAccessDriver(companyId, admin, driverId)) {
      return c.json({ message: "Driver not found." }, 404);
    }

    const row = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId,
                login_password AS loginPassword
         FROM drivers
         WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, driverId) as DriverRow | undefined;

    if (!row) {
      return c.json({ message: "Driver not found." }, 404);
    }

    return c.json(mapDriverRecord(companyId, row, 0));
  });

  companyRoutes.patch("/route47/companies/:companyId/drivers/:driverId", async (c) => {
    if (!requireAdmin(c)) {
      return c.json({ message: "Admin API key required." }, 401);
    }

    const companyId = c.req.param("companyId");
    const driverId = c.req.param("driverId");
    const admin = getAdmin(c);
    const body: DriverPatchBody = await c.req
      .json<DriverPatchBody>()
      .catch((): DriverPatchBody => ({}));

    if (!adminCanAccessDriver(companyId, admin, driverId)) {
      return c.json({ message: "Driver not found." }, 404);
    }

    const row = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId,
                login_password AS loginPassword
         FROM drivers
         WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, driverId) as DriverRow | undefined;

    if (!row) {
      return c.json({ message: "Driver not found." }, 404);
    }

    const displayName = body.name?.trim() || row.displayName || "Driver";
    const vehicleId =
      body.vehicleId !== undefined ? body.vehicleId.trim() : row.vehicleId || "";
    const branchId =
      body.branchId !== undefined ? resolveDriverBranchId(companyId, body.branchId) : row.branchId;

    let username = row.username;
    if (body.username?.trim()) {
      const requested = body.username.trim();
      const taken = db
        .prepare(
          `SELECT id FROM drivers WHERE company_id = ? AND username = ? AND id != ?`,
        )
        .get(companyId, requested, driverId);
      if (taken) {
        return c.json({ message: "Username already in use." }, 409);
      }
      username = requested;
    }

    const newPassword = body.password?.trim() || "";
    if (newPassword) {
      db.prepare(
        `UPDATE drivers
         SET display_name = ?, vehicle_id = ?, username = ?, password_hash = ?, login_password = ?, branch_id = ?
         WHERE company_id = ? AND id = ?`,
      ).run(
        displayName,
        vehicleId,
        username,
        hashPassword(newPassword),
        newPassword,
        branchId,
        companyId,
        driverId,
      );
    } else {
      db.prepare(
        `UPDATE drivers
         SET display_name = ?, vehicle_id = ?, username = ?, branch_id = ?
         WHERE company_id = ? AND id = ?`,
      ).run(displayName, vehicleId, username, branchId, companyId, driverId);
    }

    const updated = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId,
                login_password AS loginPassword
         FROM drivers
         WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, driverId) as DriverRow;

    return c.json({
      ...mapDriverRecord(companyId, updated, 0),
      phone: body.phone?.trim() ?? "",
      message: "Driver updated.",
    });
  });

  companyRoutes.patch("/route47/companies/:companyId/drivers/:driverId/status", async (c) => {
    if (!requireAdmin(c)) {
      return c.json({ message: "Admin API key required." }, 401);
    }

    const companyId = c.req.param("companyId");
    const driverId = c.req.param("driverId");
    const admin = getAdmin(c);
    const body = await c.req.json<{ status?: string }>().catch(() => ({ status: "" }));

    if (!adminCanAccessDriver(companyId, admin, driverId)) {
      return c.json({ message: "Driver not found." }, 404);
    }

    const row = db
      .prepare(
        `SELECT id, display_name AS displayName, username, vehicle_id AS vehicleId, branch_id AS branchId
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
    const admin = getAdmin(c);

    if (!adminCanAccessDriver(companyId, admin, driverId)) {
      return c.json({ message: "Driver not found." }, 404);
    }

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

  companyRoutes.delete("/route47/companies/:companyId/drivers/:driverId", (c) => {
    if (!requireAdmin(c)) {
      return c.json({ message: "Admin API key required." }, 401);
    }

    const companyId = c.req.param("companyId");
    const driverId = c.req.param("driverId");
    const admin = getAdmin(c);

    if (!adminCanAccessDriver(companyId, admin, driverId)) {
      return c.json({ message: "Driver not found." }, 404);
    }

    const driver = db
      .prepare(`SELECT id FROM drivers WHERE company_id = ? AND id = ?`)
      .get(companyId, driverId);

    if (!driver) {
      return c.json({ message: "Driver not found." }, 404);
    }

    const deviceRows = db
      .prepare(
        `SELECT driver_device_id AS driverDeviceId
         FROM device_tokens
         WHERE company_id = ? AND driver_id = ?`,
      )
      .all(companyId, driverId) as Array<{ driverDeviceId: string }>;

    for (const row of deviceRows) {
      if (row.driverDeviceId) {
        db.prepare(
          `DELETE FROM geofences WHERE company_id = ? AND driver_device_id = ?`,
        ).run(companyId, row.driverDeviceId);
      }
    }

    db.prepare(`DELETE FROM device_tokens WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );
    db.prepare(`DELETE FROM heartbeats WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );
    db.prepare(`DELETE FROM route_progress WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );
    db.prepare(`DELETE FROM route_plans WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );
    db.prepare(`DELETE FROM activity_events WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );
    db.prepare(`DELETE FROM invites WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );

    const proofRows = db
      .prepare(
        `SELECT proof_id AS proofId, file_path AS filePath
         FROM proofs
         WHERE company_id = ? AND driver_id = ?`,
      )
      .all(companyId, driverId) as Array<{ proofId: string; filePath: string }>;

    for (const proof of proofRows) {
      if (proof.filePath) {
        try {
          fs.unlinkSync(proof.filePath);
        } catch {
          // Best-effort file cleanup.
        }
      }
    }

    db.prepare(`DELETE FROM proofs WHERE company_id = ? AND driver_id = ?`).run(
      companyId,
      driverId,
    );
    db.prepare(`DELETE FROM drivers WHERE company_id = ? AND id = ?`).run(companyId, driverId);

    return c.json({
      message: "Driver deleted.",
      driverId,
    });
  });
}
