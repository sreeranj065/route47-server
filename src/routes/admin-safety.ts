import { getCompany } from "../db.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import {
  effectiveThresholds,
  readSafetySettings,
  writeSafetySettings,
  type SafetyPreset,
} from "../lib/safety-settings-store.js";
import { db } from "../db.js";
import { companyRoutes } from "./auth.js";

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

companyRoutes.get("/route47/companies/:companyId/admin/safety-settings", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);
  const settings = readSafetySettings(companyId);
  return c.json({
    settings,
    effectiveThresholds: effectiveThresholds(settings),
  });
});

/** Drivers (and admins) can read the active sensitivity profile. */
companyRoutes.get("/route47/companies/:companyId/safety-settings", (c) => {
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);
  const settings = readSafetySettings(companyId);
  return c.json({
    settings,
    effectiveThresholds: effectiveThresholds(settings),
  });
});

companyRoutes.put("/route47/companies/:companyId/admin/safety-settings", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin", "dispatcher")) {
    return c.json({ message: "Insufficient permission to change safety settings." }, 403);
  }
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req.json<{
    preset?: SafetyPreset | string;
    brakeMultiplier?: number;
    accelMultiplier?: number;
    turnMultiplier?: number;
    collisionMultiplier?: number;
    cooldownMs?: number;
    testMode?: boolean;
    applyPreset?: boolean;
  }>();

  const settings = writeSafetySettings(companyId, {
    preset: body.preset as SafetyPreset | undefined,
    brakeMultiplier: body.brakeMultiplier,
    accelMultiplier: body.accelMultiplier,
    turnMultiplier: body.turnMultiplier,
    collisionMultiplier: body.collisionMultiplier,
    cooldownMs: body.cooldownMs,
    testMode: body.testMode,
    applyPreset: body.applyPreset,
  });

  return c.json({
    settings,
    effectiveThresholds: effectiveThresholds(settings),
    message: "Safety settings saved.",
  });
});

/** Remove activity events tagged as safety-demo (seeded sample data). */
companyRoutes.delete("/route47/companies/:companyId/admin/safety-demo-events", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin", "dispatcher")) {
    return c.json({ message: "Insufficient permission." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const rows = db
    .prepare(
      `SELECT event_id AS eventId, metadata_json AS metadataJson
       FROM activity_events
       WHERE company_id = ?`,
    )
    .all(companyId) as Array<{ eventId: string; metadataJson: string }>;

  const toDelete: string[] = [];
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.metadataJson || "{}") as Record<string, unknown>;
      if (meta.source === "safety-demo" || meta.demo === true || meta.demo === "true") {
        toDelete.push(row.eventId);
      }
    } catch {
      /* ignore malformed */
    }
  }

  if (toDelete.length === 0) {
    return c.json({ message: "No demo safety events to clear.", deletedCount: 0 });
  }

  const del = db.prepare(`DELETE FROM activity_events WHERE company_id = ? AND event_id = ?`);
  for (const id of toDelete) {
    del.run(companyId, id);
  }

  return c.json({
    message: `Cleared ${toDelete.length} demo safety event(s).`,
    deletedCount: toDelete.length,
  });
});
