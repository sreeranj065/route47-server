/**
 * In-process scheduled per-branch backups (weekly / biweekly / monthly).
 */
import { db } from "../db.js";
import { listCompanyBranches } from "./admin-auth.js";
import { createBranchBackup } from "./branch-backup.js";
import { readBackupSettings, writeBackupSettings, type BackupCadence } from "./backup-settings-store.js";
import { NOTIFICATION_TYPES } from "./notification-types.js";
import { notifyAllAdmins } from "./notification-service.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function listCompanyIds(): string[] {
  return (db.prepare(`SELECT id FROM companies`).all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

function cadenceMs(cadence: BackupCadence): number {
  switch (cadence) {
    case "biweekly":
      return 14 * 24 * 60 * 60 * 1000;
    case "monthly":
      return 30 * 24 * 60 * 60 * 1000;
    case "weekly":
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

function dueForSchedule(
  cadence: BackupCadence,
  lastScheduledAtMillis: number | undefined,
  now: Date,
): boolean {
  if (lastScheduledAtMillis == null || !Number.isFinite(lastScheduledAtMillis)) {
    // First run: only fire at/after the configured hour so we don't dump
    // backups the second auto-backup is enabled.
    return now.getHours() >= 0; // allow; hour gate is applied separately
  }
  return now.getTime() - lastScheduledAtMillis >= cadenceMs(cadence);
}

async function runScheduledBackups() {
  if (running) return;
  running = true;
  try {
    for (const companyId of listCompanyIds()) {
      const settings = readBackupSettings(companyId);
      if (!settings.autoBackupEnabled) continue;

      const now = new Date();
      if (now.getHours() !== settings.scheduleHourLocal) continue;
      if (!dueForSchedule(settings.scheduleCadence, settings.lastScheduledAtMillis, now)) {
        continue;
      }

      // Mark before work so a slow run doesn't double-fire within the hour.
      writeBackupSettings(companyId, { lastScheduledAtMillis: now.getTime() });

      const branches = listCompanyBranches(companyId);
      const label =
        settings.scheduleCadence === "biweekly"
          ? "bi-weekly"
          : settings.scheduleCadence === "monthly"
            ? "monthly"
            : "weekly";

      for (const branch of branches) {
        try {
          const item = createBranchBackup({
            companyId,
            branchId: branch.id,
            trigger: "scheduled",
            note: `Automatic ${label} backup`,
          });
          notifyAllAdmins(
            companyId,
            NOTIFICATION_TYPES.BACKUP_READY,
            "Backup ready",
            `${item.displayName} is ready to download in Settings → Backup & Restore.`,
            {
              branchId: branch.id,
              backupId: item.id,
              fileName: item.fileName,
            },
            { branchId: branch.id, priority: "normal" },
          );
        } catch (error) {
          console.warn(
            `Scheduled backup failed for ${companyId}/${branch.name}:`,
            error instanceof Error ? error.message : error,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } finally {
    running = false;
  }
}

/** Call once at process start. Safe to call multiple times. */
export function startBackupScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    void runScheduledBackups();
  }, 10 * 60 * 1000);
  setTimeout(() => {
    void runScheduledBackups();
  }, 45_000);
  console.log("Backup scheduler started (weekly / biweekly / monthly).");
}
