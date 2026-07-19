/**
 * Route47 Customer Server — shared config for health checks and response metadata.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDiskHealthSummary } from "./lib/storage-metrics.js";
import { getRunningCommitSha, getSelfUpdateConfig } from "./lib/server-self-update.js";

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

export type ServerHostingMode = "docker" | "vps" | "railway" | "render" | "development";

function readHostingMode(): ServerHostingMode {
  const raw = process.env.ROUTE47_HOSTING_MODE?.trim().toLowerCase();
  if (raw === "docker" || raw === "vps" || raw === "railway" || raw === "render") return raw;
  return "development";
}

export const SERVER_HOSTING_MODE = readHostingMode();

export function isDeployHookConfigured(): boolean {
  return Boolean(process.env.ROUTE47_DEPLOY_HOOK_URL?.trim());
}

export function isRailwayUpdateConfigured(): boolean {
  return Boolean(
    process.env.ROUTE47_RAILWAY_API_TOKEN?.trim() &&
      process.env.ROUTE47_RAILWAY_SERVICE_ID?.trim() &&
      process.env.ROUTE47_RAILWAY_ENVIRONMENT_ID?.trim(),
  );
}

export const SERVER_CONFIG = {
  name: "Route47 Customer Server",
  shortName: "route47-server",
  deploymentMode: "production" as const,
  hostingMode: SERVER_HOSTING_MODE,
  version: SERVER_VERSION,
} as const;

export function buildHealthPayload(extra: Record<string, unknown> = {}) {
  const updateConfig = getSelfUpdateConfig();

  let disk: Record<string, unknown> = {};
  try {
    disk = buildDiskHealthSummary();
  } catch {
    disk = {};
  }

  return {
    ok: true,
    deploymentMode: SERVER_CONFIG.deploymentMode,
    hostingMode: updateConfig.hostingMode,
    selfUpdateSupported: updateConfig.supported,
    deployHookConfigured: updateConfig.deployHookConfigured,
    railwayConfigured: updateConfig.railwayConfigured,
    inAppUpdateSupported: updateConfig.inAppUpdateSupported,
    serverName: SERVER_CONFIG.name,
    serverVersion: SERVER_VERSION,
    version: SERVER_VERSION,
    gitCommitSha: getRunningCommitSha(),
    serverTimeMillis: Date.now(),
    adminFeatures: [
      "drivers-roster",
      "drivers-create",
      "activity-sync",
      "admin-team",
      "push-notifications",
      "storage-metrics",
      "server-update",
      "backups",
      "owner-reconnect",
    ],
    ...disk,
    ...extra,
  };
}
