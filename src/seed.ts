import { db } from "./db.js";
import { hashPassword } from "./auth.js";
import { DEMO_SERVER } from "./config.js";

export function seedDemoData() {
  const now = Date.now();

  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, created_at) VALUES (?, ?, ?)`
  ).run(DEMO_SERVER.defaultCompanyId, DEMO_SERVER.defaultCompanyName, now);

  db.prepare(
    `INSERT OR IGNORE INTO drivers (id, company_id, username, password_hash, display_name, vehicle_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "drv-demo-001",
    DEMO_SERVER.defaultCompanyId,
    DEMO_SERVER.defaultDriverUsername,
    hashPassword(DEMO_SERVER.defaultDriverPassword),
    "Demo Driver",
    "VAN-01",
    now
  );

  db.prepare(
    `INSERT OR IGNORE INTO invites (code, company_id, driver_id, vehicle_id, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    DEMO_SERVER.defaultInviteCode,
    DEMO_SERVER.defaultCompanyId,
    "drv-demo-001",
    "VAN-01",
    now + 1000 * 60 * 60 * 24 * 365,
    now
  );

  const sampleStops = [
    {
      stopId: "stop-1",
      stopNumber: 1,
      stopType: "DELIVERY",
      customerName: "Acme Cafe",
      address: "1 Main St, Sydney NSW",
      latitude: -33.8688,
      longitude: 151.2093,
      notes: "Leave at counter",
    },
    {
      stopId: "stop-2",
      stopNumber: 2,
      stopType: "DELIVERY",
      customerName: "Harbour Foods",
      address: "2 Circular Quay, Sydney NSW",
      latitude: -33.861,
      longitude: 151.211,
      notes: "",
    },
  ];

  db.prepare(
    `INSERT OR IGNORE INTO route_plans (
      route_run_id, company_id, driver_id, vehicle_id, route_date_iso, status, stops_json, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "run-demo-2026-07-01",
    DEMO_SERVER.defaultCompanyId,
    "drv-demo-001",
    "VAN-01",
    "2026-07-01",
    "published",
    JSON.stringify(sampleStops),
    now,
    now
  );

  db.prepare(
    `INSERT OR IGNORE INTO geofences (
      id, company_id, name, latitude, longitude, radius_meters, source, approval_status, driver_device_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'admin', 'approved', '', ?, ?)`
  ).run("gf-warehouse", DEMO_SERVER.defaultCompanyId, "Sydney Depot", -33.87, 151.21, 250, now, now);

  console.log(`Demo data ready (${DEMO_SERVER.defaultCompanyId}). Not for production use.`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  seedDemoData();
}
