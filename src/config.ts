/**
 * Route47 Customer Server — shared config for health checks and response metadata.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: string }).version;
    if (version) return version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

export const SERVER_VERSION = readPackageVersion();

export const SERVER_CONFIG = {
  name: "Route47 Customer Server",
  shortName: "route47-server",
  deploymentMode: "production" as const,
  version: SERVER_VERSION,
} as const;

export function buildHealthPayload(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    deploymentMode: SERVER_CONFIG.deploymentMode,
    serverName: SERVER_CONFIG.name,
    serverVersion: SERVER_VERSION,
    version: SERVER_VERSION,
    serverTimeMillis: Date.now(),
    adminFeatures: ["drivers-roster", "drivers-create", "activity-sync", "admin-team", "push-notifications"],
    ...extra,
  };
}
