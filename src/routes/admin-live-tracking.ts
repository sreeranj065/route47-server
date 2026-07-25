import { db, getCompany } from "../db.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import {
  readLiveTrackingSettings,
  writeLiveTrackingSettings,
} from "../lib/live-tracking-settings-store.js";
import { ensureDriverLiveTrackingColumn } from "../lib/branch-filter.js";
import { companyRoutes } from "./auth.js";

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

companyRoutes.get("/route47/companies/:companyId/admin/live-tracking-settings", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);
  return c.json({ settings: readLiveTrackingSettings(companyId) });
});

/** Drivers read company interval + their own enable flag. */
companyRoutes.get("/route47/companies/:companyId/live-tracking-settings", (c) => {
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  ensureDriverLiveTrackingColumn();
  const settings = readLiveTrackingSettings(companyId);
  const sessionDriverId = (c.get("driverId") ?? "").trim();
  let liveTrackingEnabled = settings.liveTrackingDefaultEnabled;

  if (sessionDriverId) {
    const row = db
      .prepare(
        `SELECT live_tracking_enabled AS liveTrackingEnabled
         FROM drivers WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, sessionDriverId) as
      | { liveTrackingEnabled?: number | null }
      | undefined;
    if (row) {
      liveTrackingEnabled = Number(row.liveTrackingEnabled ?? 1) !== 0;
    }
  }

  return c.json({
    settings,
    liveTrackingEnabled,
  });
});

companyRoutes.put("/route47/companies/:companyId/admin/live-tracking-settings", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin", "dispatcher")) {
    return c.json({ message: "Insufficient permission to change live tracking settings." }, 403);
  }
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req.json<{
    liveTrackingIntervalSeconds?: number;
    liveTrackingDefaultEnabled?: boolean;
    /** When true, set live_tracking_enabled for every driver in the company. */
    enableAllDrivers?: boolean;
    /** When true, clear live_tracking_enabled for every driver in the company. */
    disableAllDrivers?: boolean;
  }>();

  const settings = writeLiveTrackingSettings(companyId, {
    liveTrackingIntervalSeconds: body.liveTrackingIntervalSeconds as
      | 30
      | 60
      | 120
      | 300
      | 600
      | 900
      | 1800
      | undefined,
    liveTrackingDefaultEnabled: body.liveTrackingDefaultEnabled,
  });

  ensureDriverLiveTrackingColumn();
  let driversUpdated = 0;
  if (body.enableAllDrivers) {
    const result = db
      .prepare(`UPDATE drivers SET live_tracking_enabled = 1 WHERE company_id = ?`)
      .run(companyId);
    driversUpdated = Number(result.changes ?? 0);
  } else if (body.disableAllDrivers) {
    const result = db
      .prepare(`UPDATE drivers SET live_tracking_enabled = 0 WHERE company_id = ?`)
      .run(companyId);
    driversUpdated = Number(result.changes ?? 0);
  }

  return c.json({
    settings,
    driversUpdated,
    message: "Live tracking settings saved.",
  });
});
