/**
 * Per-company backup preferences (auto schedule, retention).
 * Stored under DATA_DIR so they survive redeploys with the volume.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

export interface BackupSettings {
  autoBackupEnabled: boolean;
  /** Local hour 0–23 when scheduled backups run (server local time). */
  scheduleHourLocal: number;
  retainCount: number;
  updatedAtMillis?: number;
}

const DEFAULTS: BackupSettings = {
  autoBackupEnabled: true,
  scheduleHourLocal: 3,
  retainCount: 12,
};

function settingsPath(companyId: string): string {
  return path.join(DATA_DIR, "backup-settings", `${companyId}.json`);
}

export function readBackupSettings(companyId: string): BackupSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(companyId), "utf8")) as Partial<BackupSettings>;
    return {
      autoBackupEnabled: raw.autoBackupEnabled ?? DEFAULTS.autoBackupEnabled,
      scheduleHourLocal: Math.min(
        23,
        Math.max(0, Number(raw.scheduleHourLocal ?? DEFAULTS.scheduleHourLocal) || 3),
      ),
      retainCount: Math.min(
        60,
        Math.max(1, Number(raw.retainCount ?? DEFAULTS.retainCount) || 12),
      ),
      updatedAtMillis: raw.updatedAtMillis,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeBackupSettings(
  companyId: string,
  patch: Partial<BackupSettings>,
): BackupSettings {
  const next = {
    ...readBackupSettings(companyId),
    ...patch,
    updatedAtMillis: Date.now(),
  };
  const file = settingsPath(companyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
