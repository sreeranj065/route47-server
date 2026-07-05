/**
 * Route47 Demo Server — reference implementation for local dev and QA.
 *
 * Production fleets run a customer-owned **Route47 Customer Server**
 * (same `/route47/...` API contract, hardened auth, backups, TLS, etc.).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the server version: package.json. The Admin App
// compares this value from health responses to show "update available".
function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: string }).version;
    if (version) return version;
  } catch {
    // fall through to the baked-in fallback below
  }
  return "0.0.0";
}

export const SERVER_VERSION = readPackageVersion();

export const DEMO_SERVER = {
  name: "Route47 Demo Server",
  shortName: "demo-server",
  deploymentMode: "demo" as const,
  purpose:
    "Reference server with seeded demo data. Not for production fleet use.",
  version: SERVER_VERSION,
  defaultCompanyId: "demo-co",
  defaultCompanyName: "Demo Logistics Pty Ltd",
  defaultAdminApiKey: "demo-admin-key",
  defaultDriverUsername: "demo",
  defaultDriverPassword: "demo123",
  defaultInviteCode: "DEMO-INVITE-001",
} as const;

export function demoHealthPayload(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    deploymentMode: DEMO_SERVER.deploymentMode,
    serverName: DEMO_SERVER.name,
    serverVersion: SERVER_VERSION,
    version: SERVER_VERSION,
    purpose: DEMO_SERVER.purpose,
    serverTimeMillis: Date.now(),
    adminFeatures: ["drivers-roster", "drivers-create", "activity-sync"],
    ...extra,
  };
}
