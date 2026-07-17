/**
 * Per-branch backup / restore for Route47 company servers.
 * Archives live under operational/{Company}/{Branch}/Backups/.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, getCompany } from "../db.js";
import {
  BRANCH_OPERATIONAL_FOLDERS,
  ensureBranchOperationalLayout,
  getBranchOperationalRoot,
} from "../branch-storage.js";
import { listCompanyBranches } from "./admin-auth.js";
import { defaultBranchId } from "./branch-filter.js";
import { SERVER_VERSION } from "../config.js";
import { readBackupSettings } from "./backup-settings-store.js";
import { rid } from "./util.js";

export const BACKUP_FORMAT = "route47-branch-backup";
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  backupId: string;
  companyId: string;
  companyName: string;
  branchId: string;
  branchName: string;
  displayName: string;
  createdAtMillis: number;
  serverVersion: string;
  trigger: "manual" | "scheduled" | "pre-restore";
  fileCount: number;
  dbExportSha256: string;
  note?: string;
}

export interface BackupListItem {
  id: string;
  fileName: string;
  displayName: string;
  branchId: string;
  branchName: string;
  createdAtMillis: number;
  sizeBytes: number;
  sizeMb: number;
  trigger: string;
  note?: string;
  serverVersion?: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function backupsDir(companyId: string, branchId: string): string {
  const root = ensureBranchOperationalLayout(companyId, branchId);
  return path.join(root, "Backups");
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
}

export function buildMonthlyDisplayName(branchName: string, at = new Date()): string {
  return `${branchName} - ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

function resolveArchivePath(companyId: string, branchId: string, displayName: string): string {
  const dir = backupsDir(companyId, branchId);
  fs.mkdirSync(dir, { recursive: true });
  const base = safeFileName(displayName);
  let candidate = path.join(dir, `${base}.tar.gz`);
  if (!fs.existsSync(candidate)) return candidate;
  const day = new Date().getDate().toString().padStart(2, "0");
  candidate = path.join(dir, `${base} - ${day}.tar.gz`);
  if (!fs.existsSync(candidate)) return candidate;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(dir, `${base} - ${stamp}.tar.gz`);
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runTar(args: string[], cwd?: string): void {
  const result = spawnSync("tar", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 400);
    throw new Error(detail || `tar failed (exit ${result.status})`);
  }
}

function listDriverIdsForBranch(companyId: string, branchId: string): string[] {
  const fallback = defaultBranchId(companyId);
  const rows = db
    .prepare(`SELECT id, branch_id AS branchId FROM drivers WHERE company_id = ?`)
    .all(companyId) as Array<{ id: string; branchId?: string }>;
  return rows
    .filter((row) => (row.branchId?.trim() || fallback) === branchId)
    .map((row) => row.id);
}

function selectAll(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

function buildDbExport(companyId: string, branchId: string) {
  const driverIds = listDriverIdsForBranch(companyId, branchId);
  const placeholders = driverIds.length
    ? driverIds.map(() => "?").join(",")
    : "''";

  const company = getCompany(companyId);

  const byDrivers = (table: string, extraWhere = "") => {
    if (!driverIds.length) return [];
    return selectAll(
      `SELECT * FROM ${table} WHERE company_id = ? AND driver_id IN (${placeholders}) ${extraWhere}`,
      companyId,
      ...driverIds,
    );
  };

  return {
    company: company
      ? { id: company.id, name: company.name, createdAt: company.createdAt }
      : null,
    branch:
      selectAll(
        `SELECT * FROM company_branches WHERE company_id = ? AND id = ?`,
        companyId,
        branchId,
      )[0] ?? null,
    drivers: driverIds.length
      ? selectAll(
          `SELECT * FROM drivers WHERE company_id = ? AND id IN (${placeholders})`,
          companyId,
          ...driverIds,
        )
      : [],
    invites: byDrivers("invites"),
    device_tokens: byDrivers("device_tokens"),
    heartbeats: byDrivers("heartbeats"),
    route_progress: byDrivers("route_progress"),
    route_plans: byDrivers("route_plans"),
    activity_events: byDrivers("activity_events"),
    daily_reports: byDrivers("daily_reports"),
    proofs: selectAll(
      `SELECT * FROM proofs
       WHERE company_id = ?
         AND (
           branch_id = ?
           OR (COALESCE(branch_id, '') = '' AND driver_id IN (${placeholders || "''"}))
         )`,
      companyId,
      branchId,
      ...driverIds,
    ),
    geofences: selectAll(
      `SELECT * FROM geofences WHERE company_id = ? AND branch_id = ?`,
      companyId,
      branchId,
    ),
    notifications: selectAll(
      `SELECT * FROM notifications WHERE company_id = ? AND branch_id = ?`,
      companyId,
      branchId,
    ),
    branch_shared_resources: (() => {
      try {
        return selectAll(
          `SELECT * FROM branch_shared_resources
           WHERE company_id = ? AND (source_branch_id = ? OR target_branch_id = ?)`,
          companyId,
          branchId,
          branchId,
        );
      } catch {
        return [];
      }
    })(),
    conversations: driverIds.length
      ? selectAll(
          `SELECT * FROM conversations
           WHERE company_id = ? AND driver_id IN (${placeholders})`,
          companyId,
          ...driverIds,
        )
      : [],
    messages: driverIds.length
      ? selectAll(
          `SELECT * FROM messages
           WHERE company_id = ? AND conversation_driver_id IN (${placeholders})`,
          companyId,
          ...driverIds,
        )
      : [],
    // Attachments are company-scoped files; include rows whose path sits under this branch.
    message_attachments: (() => {
      const branchRoot = getBranchOperationalRoot(companyId, branchId).replace(/\\/g, "/");
      const all = selectAll(`SELECT * FROM message_attachments WHERE company_id = ?`, companyId);
      return all.filter((row) => {
        const filePath = String(row.file_path ?? "").replace(/\\/g, "/");
        return filePath.includes(branchRoot);
      });
    })(),
  };
}

function copyOperationalFiles(
  companyId: string,
  branchId: string,
  destFilesRoot: string,
): number {
  const sourceRoot = ensureBranchOperationalLayout(companyId, branchId);
  let fileCount = 0;

  for (const folder of BRANCH_OPERATIONAL_FOLDERS) {
    if (folder === "Backups") continue;
    const from = path.join(sourceRoot, folder);
    const to = path.join(destFilesRoot, folder);
    if (!fs.existsSync(from)) continue;
    fileCount += copyTree(from, to);
  }
  return fileCount;
}

function copyTree(from: string, to: string): number {
  let count = 0;
  const stat = fs.statSync(from);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return 1;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    count += copyTree(path.join(from, entry.name), path.join(to, entry.name));
  }
  return count;
}

function rmrf(target: string) {
  fs.rmSync(target, { recursive: true, force: true });
}

function readManifestFromDir(dir: string): BackupManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  if (raw.format !== BACKUP_FORMAT) {
    throw new Error("Not a Route47 branch backup.");
  }
  if (raw.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version ${raw.formatVersion}.`);
  }
  return raw;
}

export function createBranchBackup(opts: {
  companyId: string;
  branchId: string;
  trigger: BackupManifest["trigger"];
  note?: string;
}): BackupListItem {
  const company = getCompany(opts.companyId);
  if (!company) throw new Error("Company not found.");
  const branch = listCompanyBranches(opts.companyId).find((b) => b.id === opts.branchId);
  if (!branch) throw new Error("Branch not found.");

  const createdAt = new Date();
  const displayName = buildMonthlyDisplayName(branch.name, createdAt);
  const archivePath = resolveArchivePath(opts.companyId, opts.branchId, displayName);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "route47-backup-"));

  try {
    const dbExport = buildDbExport(opts.companyId, opts.branchId);
    const dbJson = JSON.stringify(dbExport);
    const dbPath = path.join(staging, "db-export.json");
    fs.writeFileSync(dbPath, dbJson);

    const filesRoot = path.join(staging, "files");
    fs.mkdirSync(filesRoot, { recursive: true });
    const fileCount = copyOperationalFiles(opts.companyId, opts.branchId, filesRoot);

    const backupId = rid("bk");
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId,
      companyId: opts.companyId,
      companyName: company.name,
      branchId: opts.branchId,
      branchName: branch.name,
      displayName,
      createdAtMillis: createdAt.getTime(),
      serverVersion: SERVER_VERSION,
      trigger: opts.trigger,
      fileCount,
      dbExportSha256: sha256String(dbJson),
      note: opts.note,
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

    runTar(["-czf", archivePath, "-C", staging, "."]);

    const sizeBytes = fs.statSync(archivePath).size;
    pruneOldBackups(opts.companyId, opts.branchId);

    return {
      id: backupId,
      fileName: path.basename(archivePath),
      displayName,
      branchId: opts.branchId,
      branchName: branch.name,
      createdAtMillis: manifest.createdAtMillis,
      sizeBytes,
      sizeMb: Math.round((sizeBytes / (1024 * 1024)) * 10) / 10,
      trigger: opts.trigger,
      note: opts.note,
      serverVersion: SERVER_VERSION,
    };
  } catch (error) {
    if (fs.existsSync(archivePath)) rmrf(archivePath);
    throw error;
  } finally {
    rmrf(staging);
  }
}

function pruneOldBackups(companyId: string, branchId: string) {
  const retain = readBackupSettings(companyId).retainCount;
  const items = listBranchBackups(companyId, branchId);
  for (const item of items.slice(retain)) {
    const file = path.join(backupsDir(companyId, branchId), item.fileName);
    rmrf(file);
  }
}

function tryReadManifestFromArchive(archivePath: string): BackupManifest | null {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "route47-bk-meta-"));
  try {
    runTar(["-xzf", archivePath, "-C", staging, "./manifest.json"]);
    return readManifestFromDir(staging);
  } catch {
    return null;
  } finally {
    rmrf(staging);
  }
}

export function listBranchBackups(companyId: string, branchId: string): BackupListItem[] {
  const dir = backupsDir(companyId, branchId);
  if (!fs.existsSync(dir)) return [];

  const branch = listCompanyBranches(companyId).find((b) => b.id === branchId);
  const items: BackupListItem[] = [];

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".tar.gz")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    const manifest = tryReadManifestFromArchive(full);
    const displayName =
      manifest?.displayName || name.replace(/\.tar\.gz$/i, "");
    items.push({
      id: manifest?.backupId || createHash("sha1").update(full).digest("hex").slice(0, 12),
      fileName: name,
      displayName,
      branchId,
      branchName: branch?.name ?? branchId,
      createdAtMillis: manifest?.createdAtMillis ?? Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      sizeMb: Math.round((stat.size / (1024 * 1024)) * 10) / 10,
      trigger: manifest?.trigger ?? "manual",
      note: manifest?.note,
      serverVersion: manifest?.serverVersion,
    });
  }

  return items.sort((a, b) => b.createdAtMillis - a.createdAtMillis);
}

export function resolveBackupFile(
  companyId: string,
  branchId: string,
  backupIdOrFileName: string,
): { absolutePath: string; item: BackupListItem } | null {
  const items = listBranchBackups(companyId, branchId);
  const item =
    items.find((entry) => entry.id === backupIdOrFileName) ||
    items.find((entry) => entry.fileName === backupIdOrFileName);
  if (!item) return null;
  const absolutePath = path.join(backupsDir(companyId, branchId), item.fileName);
  if (!fs.existsSync(absolutePath)) return null;
  return { absolutePath, item };
}

export function deleteBranchBackup(
  companyId: string,
  branchId: string,
  backupIdOrFileName: string,
): boolean {
  const resolved = resolveBackupFile(companyId, branchId, backupIdOrFileName);
  if (!resolved) return false;
  rmrf(resolved.absolutePath);
  return true;
}

function applyDbExport(
  companyId: string,
  branchId: string,
  exportData: ReturnType<typeof buildDbExport>,
) {
  const driverIds = (exportData.drivers ?? []).map((row) => String(row.id));
  const placeholders = driverIds.length ? driverIds.map(() => "?").join(",") : "''";

  const attachmentIds = (exportData.message_attachments ?? []).map((row) => String(row.id));

  const tx = db.transaction(() => {
    // Clear existing branch-scoped rows (driver-owned + branch columns).
    if (attachmentIds.length) {
      const attPh = attachmentIds.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM message_attachments WHERE company_id = ? AND id IN (${attPh})`,
      ).run(companyId, ...attachmentIds);
    }

    if (driverIds.length) {
      db.prepare(
        `DELETE FROM messages WHERE company_id = ? AND conversation_driver_id IN (${placeholders})`,
      ).run(companyId, ...driverIds);

      db.prepare(
        `DELETE FROM conversations WHERE company_id = ? AND driver_id IN (${placeholders})`,
      ).run(companyId, ...driverIds);

      for (const table of [
        "daily_reports",
        "activity_events",
        "route_progress",
        "route_plans",
        "heartbeats",
        "device_tokens",
        "invites",
      ]) {
        db.prepare(
          `DELETE FROM ${table} WHERE company_id = ? AND driver_id IN (${placeholders})`,
        ).run(companyId, ...driverIds);
      }

      db.prepare(
        `DELETE FROM proofs WHERE company_id = ? AND (
           branch_id = ? OR driver_id IN (${placeholders})
         )`,
      ).run(companyId, branchId, ...driverIds);

      db.prepare(
        `DELETE FROM drivers WHERE company_id = ? AND id IN (${placeholders})`,
      ).run(companyId, ...driverIds);
    } else {
      db.prepare(`DELETE FROM proofs WHERE company_id = ? AND branch_id = ?`).run(
        companyId,
        branchId,
      );
    }

    db.prepare(`DELETE FROM geofences WHERE company_id = ? AND branch_id = ?`).run(
      companyId,
      branchId,
    );
    db.prepare(`DELETE FROM notifications WHERE company_id = ? AND branch_id = ?`).run(
      companyId,
      branchId,
    );
    try {
      db.prepare(
        `DELETE FROM branch_shared_resources
         WHERE company_id = ? AND (source_branch_id = ? OR target_branch_id = ?)`,
      ).run(companyId, branchId, branchId);
    } catch {
      // Table may not exist on very old servers.
    }

    // Re-insert export (drivers first).
    const insertGroup = (table: string, rows: Record<string, unknown>[] | undefined) => {
      if (!rows?.length) return;
      const columns = Object.keys(rows[0]!);
      const ph = columns.map(() => "?").join(",");
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${ph})`,
      );
      for (const row of rows) {
        stmt.run(...columns.map((col) => row[col] ?? null));
      }
    };

    if (exportData.branch) {
      insertGroup("company_branches", [exportData.branch as Record<string, unknown>]);
    }
    insertGroup("drivers", exportData.drivers as Record<string, unknown>[]);
    insertGroup("invites", exportData.invites as Record<string, unknown>[]);
    insertGroup("device_tokens", exportData.device_tokens as Record<string, unknown>[]);
    insertGroup("heartbeats", exportData.heartbeats as Record<string, unknown>[]);
    insertGroup("route_progress", exportData.route_progress as Record<string, unknown>[]);
    insertGroup("route_plans", exportData.route_plans as Record<string, unknown>[]);
    insertGroup("activity_events", exportData.activity_events as Record<string, unknown>[]);
    insertGroup("daily_reports", exportData.daily_reports as Record<string, unknown>[]);
    insertGroup("proofs", exportData.proofs as Record<string, unknown>[]);
    insertGroup("geofences", exportData.geofences as Record<string, unknown>[]);
    insertGroup("notifications", exportData.notifications as Record<string, unknown>[]);
    try {
      insertGroup(
        "branch_shared_resources",
        exportData.branch_shared_resources as Record<string, unknown>[],
      );
    } catch {
      // Older servers without branch sharing.
    }
    insertGroup("conversations", exportData.conversations as Record<string, unknown>[]);
    insertGroup("messages", exportData.messages as Record<string, unknown>[]);
    insertGroup(
      "message_attachments",
      exportData.message_attachments as Record<string, unknown>[],
    );
  });

  tx();
}

function restoreOperationalFiles(companyId: string, branchId: string, filesRoot: string) {
  const branchRoot = ensureBranchOperationalLayout(companyId, branchId);
  for (const folder of BRANCH_OPERATIONAL_FOLDERS) {
    if (folder === "Backups") continue;
    const target = path.join(branchRoot, folder);
    const source = path.join(filesRoot, folder);
    rmrf(target);
    if (fs.existsSync(source)) {
      copyTree(source, target);
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
  }
}

export function restoreBranchBackup(opts: {
  companyId: string;
  branchId: string;
  archivePath: string;
}): { ok: true; displayName: string; preRestoreBackupId: string } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "route47-restore-"));
  const rollbackRoot = path.join(
    os.tmpdir(),
    `route47-rollback-${opts.companyId}-${opts.branchId}-${Date.now()}`,
  );

  try {
    runTar(["-xzf", opts.archivePath, "-C", staging]);
    const manifest = readManifestFromDir(staging);

    if (manifest.companyId !== opts.companyId) {
      throw new Error("Backup belongs to a different company.");
    }
    if (manifest.branchId !== opts.branchId) {
      throw new Error("Backup belongs to a different branch.");
    }

    const dbPath = path.join(staging, "db-export.json");
    if (!fs.existsSync(dbPath)) throw new Error("Backup is missing db-export.json.");
    const dbJson = fs.readFileSync(dbPath, "utf8");
    if (sha256String(dbJson) !== manifest.dbExportSha256) {
      throw new Error("Backup failed integrity check (database export checksum mismatch).");
    }
    const exportData = JSON.parse(dbJson) as ReturnType<typeof buildDbExport>;

    // Rollback protection: snapshot current branch before mutating.
    const preRestore = createBranchBackup({
      companyId: opts.companyId,
      branchId: opts.branchId,
      trigger: "pre-restore",
      note: `Auto safety backup before restore of ${manifest.displayName}`,
    });

    const liveRoot = ensureBranchOperationalLayout(opts.companyId, opts.branchId);
    fs.mkdirSync(rollbackRoot, { recursive: true });
    for (const folder of BRANCH_OPERATIONAL_FOLDERS) {
      if (folder === "Backups") continue;
      const from = path.join(liveRoot, folder);
      if (fs.existsSync(from)) copyTree(from, path.join(rollbackRoot, folder));
    }

    try {
      restoreOperationalFiles(opts.companyId, opts.branchId, path.join(staging, "files"));
      applyDbExport(opts.companyId, opts.branchId, exportData);

      // Post-restore integrity: re-hash export still matches (archive unchanged).
      if (sha256File(dbPath) !== manifest.dbExportSha256) {
        throw new Error("Post-restore integrity verification failed.");
      }
    } catch (error) {
      // Roll files back; leave pre-restore archive in Backups for recovery.
      for (const folder of BRANCH_OPERATIONAL_FOLDERS) {
        if (folder === "Backups") continue;
        const target = path.join(liveRoot, folder);
        const source = path.join(rollbackRoot, folder);
        rmrf(target);
        if (fs.existsSync(source)) copyTree(source, target);
        else fs.mkdirSync(target, { recursive: true });
      }
      throw error;
    }

    return {
      ok: true,
      displayName: manifest.displayName,
      preRestoreBackupId: preRestore.id,
    };
  } finally {
    rmrf(staging);
    rmrf(rollbackRoot);
  }
}

export function importUploadedBackup(opts: {
  companyId: string;
  branchId: string;
  tempArchivePath: string;
  originalName?: string;
}): BackupListItem {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "route47-upload-"));
  try {
    runTar(["-xzf", opts.tempArchivePath, "-C", staging]);
    const manifest = readManifestFromDir(staging);
    if (manifest.companyId !== opts.companyId) {
      throw new Error("Uploaded backup belongs to a different company.");
    }
    if (manifest.branchId !== opts.branchId) {
      throw new Error("Uploaded backup belongs to a different branch.");
    }
    const dbPath = path.join(staging, "db-export.json");
    const dbJson = fs.readFileSync(dbPath, "utf8");
    if (sha256String(dbJson) !== manifest.dbExportSha256) {
      throw new Error("Uploaded backup failed integrity check.");
    }

    const dest = resolveArchivePath(opts.companyId, opts.branchId, manifest.displayName);
    fs.copyFileSync(opts.tempArchivePath, dest);
    const sizeBytes = fs.statSync(dest).size;
    return {
      id: manifest.backupId,
      fileName: path.basename(dest),
      displayName: manifest.displayName,
      branchId: opts.branchId,
      branchName: manifest.branchName,
      createdAtMillis: manifest.createdAtMillis,
      sizeBytes,
      sizeMb: Math.round((sizeBytes / (1024 * 1024)) * 10) / 10,
      trigger: manifest.trigger,
      note: manifest.note ?? opts.originalName,
      serverVersion: manifest.serverVersion,
    };
  } finally {
    rmrf(staging);
  }
}
