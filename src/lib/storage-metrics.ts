/**
 * Disk / branch storage metrics for Admin Storage Dashboard.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";
import {
  BRANCH_OPERATIONAL_FOLDERS,
  OPERATIONAL_DIR,
  getBranchOperationalRoot,
} from "../branch-storage.js";
import { listCompanyBranches } from "./admin-auth.js";

export type StorageCategory =
  | "PODs"
  | "Pickups"
  | "Receipts"
  | "Documents"
  | "Drivers"
  | "Geofence Data"
  | "Messages"
  | "Routes"
  | "Backups"
  | "Other";

const CATEGORY_FOLDERS: StorageCategory[] = [
  "PODs",
  "Pickups",
  "Receipts",
  "Documents",
  "Drivers",
  "Geofence Data",
  "Messages",
  "Routes",
  "Backups",
  "Other",
];

function parseWarnThresholds(): number[] {
  const raw = process.env.ROUTE47_STORAGE_WARN_PCT?.trim();
  if (!raw) return [80, 90, 95];
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
  return parsed.length > 0 ? parsed.sort((a, b) => a - b) : [80, 90, 95];
}

export function getStorageWarnThresholds(): number[] {
  return parseWarnThresholds();
}

function directorySizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return total;
}

function latestMtimeMillis(dirPath: string): number | null {
  if (!fs.existsSync(dirPath)) return null;
  let latest: number | null = null;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        const stat = fs.statSync(full);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          const ms = stat.mtimeMs;
          if (latest == null || ms > latest) latest = ms;
        }
      } catch {
        /* skip */
      }
    }
  }
  return latest;
}

export function readVolumeStats(targetDir: string = DATA_DIR): {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
} {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const free = fs.statfsSync(targetDir);
    const blockSize = Number(free.bsize ?? 0);
    const totalBlocks = Number(free.blocks ?? 0);
    const availableBlocks = Number(free.bavail ?? free.bfree ?? 0);
    const totalBytes = blockSize * totalBlocks;
    const availableBytes = blockSize * availableBlocks;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return { totalBytes, usedBytes, availableBytes };
  } catch {
    // Fallback: treat DATA_DIR contents as "used" with unknown capacity.
    const usedBytes = directorySizeBytes(targetDir);
    return {
      totalBytes: usedBytes > 0 ? usedBytes : 1,
      usedBytes,
      availableBytes: 0,
    };
  }
}

function categorizeFolderName(name: string): StorageCategory {
  if ((BRANCH_OPERATIONAL_FOLDERS as readonly string[]).includes(name)) {
    return name as StorageCategory;
  }
  return "Other";
}

function branchCategoryBreakdown(branchRoot: string): Record<StorageCategory, number> {
  const breakdown = Object.fromEntries(CATEGORY_FOLDERS.map((c) => [c, 0])) as Record<
    StorageCategory,
    number
  >;
  if (!fs.existsSync(branchRoot)) return breakdown;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(branchRoot, { withFileTypes: true });
  } catch {
    return breakdown;
  }

  for (const entry of entries) {
    const full = path.join(branchRoot, entry.name);
    const bytes = entry.isDirectory() || entry.isFile() ? directorySizeBytes(full) : 0;
    const category = categorizeFolderName(entry.name);
    breakdown[category] += bytes;
  }
  return breakdown;
}

export function buildStorageMetrics(companyId: string, branchIds: string[]) {
  const volume = readVolumeStats(DATA_DIR);
  const warnThresholdsPercent = getStorageWarnThresholds();
  const usedPercent =
    volume.totalBytes > 0 ? Math.round((volume.usedBytes / volume.totalBytes) * 1000) / 10 : 0;

  const branchesMeta = listCompanyBranches(companyId).filter((b) => branchIds.includes(b.id));
  let lastBackupAt: number | null = null;

  const branches = branchesMeta.map((branch) => {
    const root = getBranchOperationalRoot(companyId, branch.id);
    const categories = branchCategoryBreakdown(root);
    const usedBytes = Object.values(categories).reduce((sum, n) => sum + n, 0);
    const backupMs = latestMtimeMillis(path.join(root, "Backups"));
    if (backupMs != null && (lastBackupAt == null || backupMs > lastBackupAt)) {
      lastBackupAt = backupMs;
    }
    return {
      branchId: branch.id,
      branchName: branch.name,
      isPrimary: branch.is_primary === 1,
      usedBytes,
      percentOfVolume:
        volume.totalBytes > 0
          ? Math.round((usedBytes / volume.totalBytes) * 1000) / 10
          : 0,
      categories: CATEGORY_FOLDERS.map((name) => ({
        name,
        usedBytes: categories[name],
        percentOfBranch:
          usedBytes > 0 ? Math.round((categories[name] / usedBytes) * 1000) / 10 : 0,
      })),
    };
  });

  // Host-level VPS backups outside operational tree (install.sh).
  const hostBackupDir = process.env.ROUTE47_BACKUP_DIR?.trim();
  if (hostBackupDir) {
    const hostBackupMs = latestMtimeMillis(hostBackupDir);
    if (hostBackupMs != null && (lastBackupAt == null || hostBackupMs > lastBackupAt)) {
      lastBackupAt = hostBackupMs;
    }
  }

  const activeThreshold =
    warnThresholdsPercent.filter((t) => usedPercent >= t).pop() ?? null;

  return {
    companyId,
    dataDir: DATA_DIR,
    operationalDir: OPERATIONAL_DIR,
    totalBytes: volume.totalBytes,
    usedBytes: volume.usedBytes,
    availableBytes: volume.availableBytes,
    usedPercent,
    warnThresholdsPercent,
    warningLevelPercent: activeThreshold,
    lastBackupAtMillis: lastBackupAt,
    branches,
  };
}

/** Newest backup mtime across host backup dir + operational `Backups` folders. */
function findLatestBackupAtMillis(): number | null {
  let latest: number | null = null;
  const consider = (ms: number | null) => {
    if (ms == null) return;
    if (latest == null || ms > latest) latest = ms;
  };

  const hostBackupDir = process.env.ROUTE47_BACKUP_DIR?.trim();
  if (hostBackupDir) consider(latestMtimeMillis(hostBackupDir));

  // OPERATIONAL_DIR / {Company} / {Branch} / Backups
  if (fs.existsSync(OPERATIONAL_DIR)) {
    try {
      for (const company of fs.readdirSync(OPERATIONAL_DIR, { withFileTypes: true })) {
        if (!company.isDirectory()) continue;
        const companyPath = path.join(OPERATIONAL_DIR, company.name);
        let branches: fs.Dirent[];
        try {
          branches = fs.readdirSync(companyPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const branch of branches) {
          if (!branch.isDirectory()) continue;
          consider(latestMtimeMillis(path.join(companyPath, branch.name, "Backups")));
        }
      }
    } catch {
      /* ignore scan errors */
    }
  }

  return latest;
}

/** Lightweight disk summary for health payloads (Admin status pill). */
export function buildDiskHealthSummary() {
  const volume = readVolumeStats(DATA_DIR);
  const usedPercent =
    volume.totalBytes > 0 ? Math.round((volume.usedBytes / volume.totalBytes) * 1000) / 10 : 0;
  const warnThresholds = getStorageWarnThresholds();
  const warningLevelPercent =
    warnThresholds.filter((t) => usedPercent >= t).pop() ?? null;
  return {
    diskTotalBytes: volume.totalBytes,
    diskUsedBytes: volume.usedBytes,
    diskAvailableBytes: volume.availableBytes,
    diskUsedPercent: usedPercent,
    storageWarnThresholdsPercent: warnThresholds,
    diskWarningLevelPercent: warningLevelPercent,
    lastBackupAtMillis: findLatestBackupAtMillis(),
  };
}
