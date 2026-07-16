/**
 * Customer-entered update credentials (Railway / Render), stored on the
 * company server volume so Play Store Admin users never have to edit host
 * env vars after first setup. Env vars still win when both are set.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

const CREDENTIALS_FILE = path.join(DATA_DIR, ".update-credentials.json");

export interface StoredUpdateCredentials {
  railwayApiToken?: string;
  railwayServiceId?: string;
  railwayEnvironmentId?: string;
  deployHookUrl?: string;
  hostingMode?: "railway" | "render" | "vps" | "docker" | "development";
  updatedAtMillis?: number;
}

export function readStoredUpdateCredentials(): StoredUpdateCredentials {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8")) as StoredUpdateCredentials;
  } catch {
    return {};
  }
}

export function writeStoredUpdateCredentials(
  patch: StoredUpdateCredentials,
): StoredUpdateCredentials {
  const prev = readStoredUpdateCredentials();
  const next: StoredUpdateCredentials = {
    ...prev,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
    updatedAtMillis: Date.now(),
  };

  // Allow clearing a field with empty string.
  for (const key of [
    "railwayApiToken",
    "railwayServiceId",
    "railwayEnvironmentId",
    "deployHookUrl",
  ] as const) {
    if (patch[key] === "") {
      delete next[key];
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function maskSecret(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  if (v.length <= 8) return "••••••••";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
