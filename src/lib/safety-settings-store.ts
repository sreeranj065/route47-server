/**
 * Per-company safety detection sensitivity (applied by driver phones).
 * Stored under DATA_DIR so it survives redeploys with the volume.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

export type SafetyPreset = "sensitive" | "balanced" | "relaxed";

export interface SafetySettings {
  preset: SafetyPreset;
  /** Multipliers < 1 = more sensitive (lower thresholds). */
  brakeMultiplier: number;
  accelMultiplier: number;
  turnMultiplier: number;
  collisionMultiplier: number;
  /** Event cooldown in milliseconds (default 45000). */
  cooldownMs: number;
  /** When true, drivers show on-device feedback and use a shorter cooldown. */
  testMode: boolean;
  updatedAtMillis?: number;
}

const PRESET_VALUES: Record<
  SafetyPreset,
  Omit<SafetySettings, "preset" | "testMode" | "updatedAtMillis">
> = {
  sensitive: {
    brakeMultiplier: 0.75,
    accelMultiplier: 0.75,
    turnMultiplier: 0.75,
    collisionMultiplier: 0.85,
    cooldownMs: 25_000,
  },
  balanced: {
    brakeMultiplier: 1,
    accelMultiplier: 1,
    turnMultiplier: 1,
    collisionMultiplier: 1,
    cooldownMs: 45_000,
  },
  relaxed: {
    brakeMultiplier: 1.35,
    accelMultiplier: 1.35,
    turnMultiplier: 1.35,
    collisionMultiplier: 1.25,
    cooldownMs: 60_000,
  },
};

const DEFAULTS: SafetySettings = {
  preset: "balanced",
  ...PRESET_VALUES.balanced,
  testMode: false,
};

function clampMultiplier(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2.5, Math.max(0.4, n));
}

function clampCooldown(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(180_000, Math.max(5_000, Math.round(n)));
}

function normalizePreset(value: unknown): SafetyPreset {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "sensitive" || raw === "relaxed") return raw;
  return "balanced";
}

function settingsPath(companyId: string): string {
  return path.join(DATA_DIR, "safety-settings", `${companyId}.json`);
}

export function presetDefaults(preset: SafetyPreset): SafetySettings {
  return {
    preset,
    ...PRESET_VALUES[preset],
    testMode: false,
  };
}

export function readSafetySettings(companyId: string): SafetySettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(companyId), "utf8")) as Partial<SafetySettings>;
    return {
      preset: normalizePreset(raw.preset),
      brakeMultiplier: clampMultiplier(raw.brakeMultiplier, DEFAULTS.brakeMultiplier),
      accelMultiplier: clampMultiplier(raw.accelMultiplier, DEFAULTS.accelMultiplier),
      turnMultiplier: clampMultiplier(raw.turnMultiplier, DEFAULTS.turnMultiplier),
      collisionMultiplier: clampMultiplier(raw.collisionMultiplier, DEFAULTS.collisionMultiplier),
      cooldownMs: clampCooldown(raw.cooldownMs, DEFAULTS.cooldownMs),
      testMode: Boolean(raw.testMode),
      updatedAtMillis: typeof raw.updatedAtMillis === "number" ? raw.updatedAtMillis : undefined,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSafetySettings(
  companyId: string,
  patch: Partial<SafetySettings> & { applyPreset?: boolean },
): SafetySettings {
  const current = readSafetySettings(companyId);
  const preset = normalizePreset(patch.preset ?? current.preset);

  let next: SafetySettings;
  if (patch.applyPreset || (patch.preset && patch.brakeMultiplier == null)) {
    next = {
      ...presetDefaults(preset),
      testMode: patch.testMode ?? current.testMode,
      updatedAtMillis: Date.now(),
    };
  } else {
    next = {
      preset,
      brakeMultiplier: clampMultiplier(patch.brakeMultiplier, current.brakeMultiplier),
      accelMultiplier: clampMultiplier(patch.accelMultiplier, current.accelMultiplier),
      turnMultiplier: clampMultiplier(patch.turnMultiplier, current.turnMultiplier),
      collisionMultiplier: clampMultiplier(patch.collisionMultiplier, current.collisionMultiplier),
      cooldownMs: clampCooldown(patch.cooldownMs, current.cooldownMs),
      testMode: patch.testMode ?? current.testMode,
      updatedAtMillis: Date.now(),
    };
  }

  const file = settingsPath(companyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

/** Effective thresholds shown in Admin (base × multiplier). */
export function effectiveThresholds(settings: SafetySettings) {
  return {
    harshBrakingMinDecelMs2: Number((3.5 * settings.brakeMultiplier).toFixed(2)),
    harshBrakingMinSpeedDropKmh: Number((12 * settings.brakeMultiplier).toFixed(1)),
    hardAccelMinMs2: Number((3.0 * settings.accelMultiplier).toFixed(2)),
    hardAccelMinSpeedGainKmh: Number((8 * settings.accelMultiplier).toFixed(1)),
    sharpTurnMinGyroRadS: Number((2.0 * settings.turnMultiplier).toFixed(2)),
    collisionMinAccelMs2: Number((7.0 * settings.collisionMultiplier).toFixed(2)),
    cooldownMs: settings.testMode
      ? Math.min(settings.cooldownMs, 12_000)
      : settings.cooldownMs,
  };
}
