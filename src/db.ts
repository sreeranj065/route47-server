import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

// All persistent state (SQLite DB + proof photo files) lives under DATA_DIR so a
// single mounted volume (e.g. /data on Render/Railway/Docker) survives redeploys.
// Defaults to <repo>/data for local dev, same as before.
export const DATA_DIR = process.env.DATA_DIR?.trim() || path.join(ROOT_DIR, "data");
export const PROOFS_DIR = path.join(DATA_DIR, "proofs");
export const DB_PATH = process.env.ROUTE47_DB_PATH ?? path.join(DATA_DIR, "route47-demo.db");

fs.mkdirSync(PROOFS_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    vehicle_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(company_id, username)
  );

  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    driver_id TEXT,
    vehicle_id TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_tokens (
    token TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    driver_device_id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    driver_device_id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL DEFAULT '',
    route_run_id TEXT NOT NULL DEFAULT '',
    active_stop_id TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    battery_level_percent INTEGER,
    network_status TEXT NOT NULL DEFAULT 'unknown',
    app_version_name TEXT NOT NULL DEFAULT '',
    app_build_type TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    driver_device_id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL DEFAULT '',
    route_run_id TEXT NOT NULL,
    stop_id TEXT NOT NULL DEFAULT '',
    stop_number INTEGER NOT NULL DEFAULT 0,
    stop_status TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_plans (
    route_run_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL DEFAULT '',
    vehicle_id TEXT NOT NULL DEFAULT '',
    route_date_iso TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published',
    stops_json TEXT NOT NULL DEFAULT '[]',
    published_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (company_id, route_run_id)
  );

  CREATE TABLE IF NOT EXISTS proofs (
    proof_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL DEFAULT '',
    driver_device_id TEXT NOT NULL DEFAULT '',
    vehicle_id TEXT NOT NULL DEFAULT '',
    route_run_id TEXT NOT NULL DEFAULT '',
    stop_id TEXT NOT NULL DEFAULT '',
    proof_type TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS geofences (
    id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radius_meters REAL NOT NULL DEFAULT 120,
    source TEXT NOT NULL DEFAULT 'admin',
    approval_status TEXT NOT NULL DEFAULT 'approved',
    driver_device_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (company_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_heartbeats_company_time
    ON heartbeats(company_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_geofences_company_status
    ON geofences(company_id, approval_status);

  CREATE TABLE IF NOT EXISTS activity_events (
    event_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    route_id TEXT NOT NULL DEFAULT '',
    stop_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT '',
    timestamp_millis INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_activity_events_company_driver_time
    ON activity_events(company_id, driver_id, timestamp_millis DESC);

  CREATE TABLE IF NOT EXISTS daily_reports (
    report_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    driver_id TEXT NOT NULL DEFAULT '',
    driver_device_id TEXT NOT NULL DEFAULT '',
    vehicle_id TEXT NOT NULL DEFAULT '',
    route_run_id TEXT NOT NULL DEFAULT '',
    route_date_iso TEXT NOT NULL,
    total_stops INTEGER NOT NULL DEFAULT 0,
    completed_stops INTEGER NOT NULL DEFAULT 0,
    skipped_stops INTEGER NOT NULL DEFAULT 0,
    failed_stops INTEGER NOT NULL DEFAULT 0,
    proof_count INTEGER NOT NULL DEFAULT 0,
    receipt_count INTEGER NOT NULL DEFAULT 0,
    total_distance_meters REAL NOT NULL DEFAULT 0,
    total_drive_time_seconds INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (company_id, driver_id, route_run_id, route_date_iso)
  );

  CREATE INDEX IF NOT EXISTS idx_daily_reports_company_date
    ON daily_reports(company_id, route_date_iso DESC);

  CREATE INDEX IF NOT EXISTS idx_daily_reports_company_driver
    ON daily_reports(company_id, driver_id, created_at DESC);
`);

function ensureGeofenceLinkageColumns() {
  const columns = db
    .prepare(`PRAGMA table_info(geofences)`)
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("stop_id")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN stop_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!names.has("route_id")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN route_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!names.has("last_triggered_at_millis")) {
    db.exec(`ALTER TABLE geofences ADD COLUMN last_triggered_at_millis INTEGER NOT NULL DEFAULT 0`);
  }
}

ensureGeofenceLinkageColumns();

export type GeofenceRow = {
  id: string;
  company_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  source: string;
  approval_status: string;
  driver_device_id: string;
  stop_id: string;
  route_id: string;
  last_triggered_at_millis: number;
  created_at: number;
  updated_at: number;
};

export type DailyReportRow = {
  report_id: string;
  company_id: string;
  driver_id: string;
  driver_device_id: string;
  vehicle_id: string;
  route_run_id: string;
  route_date_iso: string;
  total_stops: number;
  completed_stops: number;
  skipped_stops: number;
  failed_stops: number;
  proof_count: number;
  receipt_count: number;
  total_distance_meters: number;
  total_drive_time_seconds: number;
  created_at: number;
  received_at: number;
};

export type RoutePlanRow = {
  route_run_id: string;
  company_id: string;
  driver_id: string;
  vehicle_id: string;
  route_date_iso: string;
  status: string;
  stops_json: string;
  published_at: number;
  updated_at: number;
};

export function getCompany(companyId: string) {
  return db
    .prepare(`SELECT id, name, created_at AS createdAt FROM companies WHERE id = ?`)
    .get(companyId) as { id: string; name: string; createdAt: number } | undefined;
}

export function geofenceToJson(row: GeofenceRow) {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radius_meters,
    source: row.source,
    approvalStatus: row.approval_status,
    driverDeviceId: row.driver_device_id,
    stopId: row.stop_id || undefined,
    routeId: row.route_id || undefined,
    lastTriggeredAtMillis: row.last_triggered_at_millis || undefined,
    createdAtMillis: row.created_at,
    updatedAtMillis: row.updated_at,
  };
}

export function dailyReportToJson(row: DailyReportRow) {
  return {
    reportId: row.report_id,
    companyId: row.company_id,
    driverId: row.driver_id,
    driverDeviceId: row.driver_device_id,
    vehicleId: row.vehicle_id,
    routeRunId: row.route_run_id,
    routeDateIso: row.route_date_iso,
    totalStops: row.total_stops,
    completedStops: row.completed_stops,
    skippedStops: row.skipped_stops,
    failedStops: row.failed_stops,
    proofCount: row.proof_count,
    receiptCount: row.receipt_count,
    totalDistanceMeters: row.total_distance_meters,
    totalDriveTimeSeconds: row.total_drive_time_seconds,
    createdAtMillis: row.created_at,
    receivedAtMillis: row.received_at,
  };
}

export function routePlanToJson(row: RoutePlanRow) {
  return {
    routeRunId: row.route_run_id,
    routeDateIso: row.route_date_iso,
    driverId: row.driver_id,
    vehicleId: row.vehicle_id,
    status: row.status,
    stops: JSON.parse(row.stops_json || "[]"),
    publishedAtMillis: row.published_at,
    updatedAtMillis: row.updated_at,
  };
}
