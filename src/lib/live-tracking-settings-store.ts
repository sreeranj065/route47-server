/**
 * Per-company live tracking policy (interval + default for new drivers).
 * Stored under DATA_DIR so it survives redeploys with the volume.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

export const LIVE_TRACKING_INTERVAL_OPTIONS_SECONDS = [
  30, 60, 120, 300, 600, 900, 1800,
] as const;

export type LiveTrackingIntervalSeconds =
  (typeof LIVE_TRACKING_INTERVAL_OPTIONS_SECONDS)[number];

export interface LiveTrackingSettings {
  /** How often drivers transmit live location while Live Tracking is enabled. */
  liveTrackingIntervalSeconds: LiveTrackingIntervalSeconds;
  /** Default for newly created drivers. */
  liveTrackingDefaultEnabled: boolean;
  updatedAtMillis?: number;
}

const DEFAULTS: LiveTrackingSettings = {
  liveTrackingIntervalSeconds: 120,
  liveTrackingDefaultEnabled: true,
};

function settingsPath(companyId: string): string {
  return path.join(DATA_DIR, "live-tracking-settings", `${companyId}.json`);
}

export function normalizeLiveTrackingIntervalSeconds(
  value: unknown,
): LiveTrackingIntervalSeconds {
  const n = Number(value);
  if (
    LIVE_TRACKING_INTERVAL_OPTIONS_SECONDS.includes(
      n as LiveTrackingIntervalSeconds,
    )
  ) {
    return n as LiveTrackingIntervalSeconds;
  }
  return DEFAULTS.liveTrackingIntervalSeconds;
}

export function readLiveTrackingSettings(companyId: string): LiveTrackingSettings {
  try {
    const raw = JSON.parse(
      fs.readFileSync(settingsPath(companyId), "utf8"),
    ) as Partial<LiveTrackingSettings>;
    return {
      liveTrackingIntervalSeconds: normalizeLiveTrackingIntervalSeconds(
        raw.liveTrackingIntervalSeconds,
      ),
      liveTrackingDefaultEnabled:
        raw.liveTrackingDefaultEnabled === undefined
          ? DEFAULTS.liveTrackingDefaultEnabled
          : Boolean(raw.liveTrackingDefaultEnabled),
      updatedAtMillis:
        typeof raw.updatedAtMillis === "number" ? raw.updatedAtMillis : undefined,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeLiveTrackingSettings(
  companyId: string,
  patch: Partial<LiveTrackingSettings>,
): LiveTrackingSettings {
  const current = readLiveTrackingSettings(companyId);
  const next: LiveTrackingSettings = {
    liveTrackingIntervalSeconds: normalizeLiveTrackingIntervalSeconds(
      patch.liveTrackingIntervalSeconds ?? current.liveTrackingIntervalSeconds,
    ),
    liveTrackingDefaultEnabled:
      patch.liveTrackingDefaultEnabled === undefined
        ? current.liveTrackingDefaultEnabled
        : Boolean(patch.liveTrackingDefaultEnabled),
    updatedAtMillis: Date.now(),
  };

  const file = settingsPath(companyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
