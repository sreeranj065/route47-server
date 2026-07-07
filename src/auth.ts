import crypto from "node:crypto";
import { db } from "./db.js";
import { SERVER_CONFIG } from "./config.js";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

export function createDeviceToken(input: {
  companyId: string;
  driverId: string;
  driverDeviceId: string;
  vehicleId: string;
}) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + TOKEN_TTL_MS;

  db.prepare(
    `INSERT INTO device_tokens (token, company_id, driver_id, driver_device_id, vehicle_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    input.companyId,
    input.driverId,
    input.driverDeviceId,
    input.vehicleId,
    expiresAt,
    now
  );

  return { token, expiresAt };
}

export function resolveDeviceToken(token: string | undefined) {
  if (!token?.trim()) return null;

  const row = db
    .prepare(
      `SELECT token, company_id AS companyId, driver_id AS driverId,
              driver_device_id AS driverDeviceId, vehicle_id AS vehicleId, expires_at AS expiresAt
       FROM device_tokens WHERE token = ?`
    )
    .get(token.trim()) as
    | {
        token: string;
        companyId: string;
        driverId: string;
        driverDeviceId: string;
        vehicleId: string;
        expiresAt: number;
      }
    | undefined;

  if (!row) return null;
  if (row.expiresAt < Date.now()) return null;
  return row;
}

export function getExpectedAdminApiKey(): string {
  return process.env.ROUTE47_ADMIN_API_KEY?.trim() ?? "";
}

export function isValidAdminKey(provided: string | undefined): boolean {
  const expected = getExpectedAdminApiKey();
  const value = provided?.trim() ?? "";
  if (!expected || !value || expected.length !== value.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function resolveAdminKey(provided: string | undefined): boolean {
  return isValidAdminKey(provided);
}

export function newDriverDeviceId() {
  return `dev-${crypto.randomBytes(6).toString("hex")}`;
}

export function buildConnectionResponse(input: {
  message: string;
  serverUrl: string;
  companyId: string;
  companyName: string;
  driverId: string;
  driverDeviceId: string;
  vehicleId: string;
  driverName: string;
  deviceAuthToken: string;
  deviceAuthTokenExpiresAtMillis: number;
}) {
  return {
    message: input.message,
    deploymentMode: SERVER_CONFIG.deploymentMode,
    serverUrl: input.serverUrl,
    companyId: input.companyId,
    companyName: input.companyName,
    driverId: input.driverId,
    driverDeviceId: input.driverDeviceId,
    deviceId: input.driverDeviceId,
    vehicleId: input.vehicleId,
    driverName: input.driverName,
    deviceAuthToken: input.deviceAuthToken,
    authToken: input.deviceAuthToken,
    deviceAuthTokenExpiresAtMillis: input.deviceAuthTokenExpiresAtMillis,
    tokenExpiresAtMillis: input.deviceAuthTokenExpiresAtMillis,
  };
}

export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function isAdminRequest(authHeader: string | undefined, adminKeyHeader: string | undefined) {
  if (resolveAdminKey(adminKeyHeader ?? bearerToken(authHeader))) {
    return true;
  }
  return false;
}
