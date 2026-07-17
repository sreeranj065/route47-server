/**
 * In-process nightly per-branch backups. Does not block request handling —
 * work runs on a timer and each branch is backed up sequentially with yields.
 */
import { db } from "../db.js";
import { listCompanyBranches } from "./admin-auth.js";
import { createBranchBackup } from "./branch-backup.js";
import { readBackupSettings } from "./backup-settings-store.js";
import { NOTIFICATION_TYPES } from "./notification-types.js";
import { notifyAllAdmins } from "./notification-service.js";

let timer: ReturnType<typeof setInterval> | null = null;
const ranDayKeys = new Set<string>();
let running = false;

function listCompanyIds(): string[] {
  return (db.prepare(`SELECT id FROM companies`).all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
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
      const key = `${companyId}:${dayKey(now)}`;
      if (ranDayKeys.has(key)) continue;
      // Mark early so a slow run doesn't double-fire within the hour.
      ranDayKeys.add(key);
      if (ranDayKeys.size > 200) {
        const prefix = dayKey(now);
        for (const entry of [...ranDayKeys]) {
          if (!entry.endsWith(prefix)) ranDayKeys.delete(entry);
        }
      }

      const branches = listCompanyBranches(companyId);
      for (const branch of branches) {
        try {
          const item = createBranchBackup({
            companyId,
            branchId: branch.id,
            trigger: "scheduled",
            note: "Automatic nightly backup",
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
        // Yield between branches so live traffic stays responsive.
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
  // Check every 10 minutes; runs at most once per company per local day.
  timer = setInterval(() => {
    void runScheduledBackups();
  }, 10 * 60 * 1000);
  // Opportunistic check shortly after boot (non-blocking).
  setTimeout(() => {
    void runScheduledBackups();
  }, 45_000);
  console.log("Backup scheduler started (per-branch nightly).");
}
