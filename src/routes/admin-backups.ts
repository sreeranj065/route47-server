import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCompany } from "../db.js";
import { listCompanyBranches, requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import { adminCanAccessBranch, getAdminAllowedBranchIds } from "../lib/branch-filter.js";
import {
  createBranchBackup,
  deleteBranchBackup,
  importUploadedBackup,
  listBranchBackups,
  resolveBackupFile,
  restoreBranchBackup,
} from "../lib/branch-backup.js";
import { readBackupSettings, writeBackupSettings, type BackupCadence } from "../lib/backup-settings-store.js";
import { purgeBranchProofFiles } from "../lib/purge-proof-files.js";
import { NOTIFICATION_TYPES } from "../lib/notification-types.js";
import { notifyAllAdmins } from "../lib/notification-service.js";
import { companyRoutes } from "./auth.js";

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

function accessibleBranches(companyId: string, admin: AdminIdentity | null) {
  const all = listCompanyBranches(companyId);
  const allowed = getAdminAllowedBranchIds(companyId, admin);
  if (allowed === null) return all;
  return all.filter((branch) => allowed.includes(branch.id));
}

companyRoutes.get("/route47/companies/:companyId/admin/backups/settings", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);
  return c.json(readBackupSettings(companyId));
});

companyRoutes.put("/route47/companies/:companyId/admin/backups/settings", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can change backup settings." }, 403);
  }
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req.json<{
    autoBackupEnabled?: boolean;
    scheduleCadence?: BackupCadence | string;
    scheduleHourLocal?: number;
    retainCount?: number;
  }>();

  const saved = writeBackupSettings(companyId, {
    autoBackupEnabled: body.autoBackupEnabled,
    scheduleCadence: body.scheduleCadence as BackupCadence | undefined,
    scheduleHourLocal: body.scheduleHourLocal,
    retainCount: body.retainCount,
  });
  return c.json(saved);
});

/**
 * Delete POD / Pickup / Receipt files only (after an automatic backup).
 * Never touches drivers, geofences, team, licenses, routes, trips, etc.
 */
companyRoutes.post("/route47/companies/:companyId/admin/storage/purge-proofs", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can delete proof files." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req.json<{ branchId?: string; confirm?: boolean }>();
  const branchId = body.branchId?.trim() ?? "";
  if (!branchId) return c.json({ message: "branchId is required." }, 400);
  if (body.confirm !== true) {
    return c.json({ message: "confirm: true is required." }, 400);
  }
  if (!adminCanAccessBranch(companyId, admin, branchId)) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  try {
    const result = purgeBranchProofFiles({ companyId, branchId });
    notifyAllAdmins(
      companyId,
      NOTIFICATION_TYPES.BACKUP_READY,
      "Proof files deleted",
      `POD / Pickup / Receipt files were deleted for this branch. A backup was saved first (${result.backupId}).`,
      { branchId, backupId: result.backupId },
      { branchId, priority: "high" },
    );
    return c.json({
      ok: true,
      message: `Deleted ${result.deletedProofRows} proof record(s). Backup ${result.backupId} created first.`,
      ...result,
    });
  } catch (error) {
    return c.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "Could not delete proof files (backup may have failed).",
      },
      500,
    );
  }
});

companyRoutes.get("/route47/companies/:companyId/admin/backups", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const requestedBranch = c.req.query("branchId")?.trim() ?? "";
  const branches = accessibleBranches(companyId, admin);
  const targetBranches = requestedBranch
    ? branches.filter((b) => b.id === requestedBranch)
    : branches;

  if (requestedBranch && targetBranches.length === 0) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  const backups = targetBranches.flatMap((branch) => listBranchBackups(companyId, branch.id));
  backups.sort((a, b) => b.createdAtMillis - a.createdAtMillis);

  return c.json({
    backups,
    branches: branches.map((b) => ({ id: b.id, name: b.name, isPrimary: b.is_primary === 1 })),
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/backups", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin", "dispatcher")) {
    return c.json({ message: "Insufficient permission to create backups." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req.json<{ branchId?: string; note?: string }>();
  const branchId = body.branchId?.trim() ?? "";
  if (!branchId) return c.json({ message: "branchId is required." }, 400);
  if (!adminCanAccessBranch(companyId, admin, branchId)) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  try {
    const item = createBranchBackup({
      companyId,
      branchId,
      trigger: "manual",
      note: body.note?.trim() || "Manual backup",
    });
    notifyAllAdmins(
      companyId,
      NOTIFICATION_TYPES.BACKUP_READY,
      "Backup ready",
      `${item.displayName} is ready to download.`,
      { branchId, backupId: item.id, fileName: item.fileName },
      { branchId, priority: "normal" },
    );
    return c.json({ backup: item }, 201);
  } catch (error) {
    return c.json(
      { message: error instanceof Error ? error.message : "Backup failed." },
      500,
    );
  }
});

companyRoutes.get("/route47/companies/:companyId/admin/backups/:backupId/download", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  const companyId = c.req.param("companyId");
  const backupId = c.req.param("backupId");
  const branchId = c.req.query("branchId")?.trim() ?? "";
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);
  if (!branchId) return c.json({ message: "branchId query parameter is required." }, 400);
  if (!adminCanAccessBranch(companyId, admin, branchId)) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  const resolved = resolveBackupFile(companyId, branchId, backupId);
  if (!resolved) return c.json({ message: "Backup not found." }, 404);

  const bytes = fs.readFileSync(resolved.absolutePath);
  return c.body(bytes, 200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${resolved.item.fileName.replace(/"/g, "")}"`,
    "Content-Length": String(bytes.length),
  });
});

companyRoutes.delete("/route47/companies/:companyId/admin/backups/:backupId", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can delete backups." }, 403);
  }
  const companyId = c.req.param("companyId");
  const backupId = c.req.param("backupId");
  const branchId = c.req.query("branchId")?.trim() ?? "";
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);
  if (!branchId) return c.json({ message: "branchId query parameter is required." }, 400);
  if (!adminCanAccessBranch(companyId, admin, branchId)) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  const ok = deleteBranchBackup(companyId, branchId, backupId);
  if (!ok) return c.json({ message: "Backup not found." }, 404);
  return c.json({ ok: true });
});

companyRoutes.post("/route47/companies/:companyId/admin/backups/:backupId/restore", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can restore backups." }, 403);
  }
  const companyId = c.req.param("companyId");
  const backupId = c.req.param("backupId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    branchId?: string;
    confirm?: boolean;
  };
  const branchId = body.branchId?.trim() ?? c.req.query("branchId")?.trim() ?? "";
  if (!branchId) return c.json({ message: "branchId is required." }, 400);
  if (!body.confirm) {
    return c.json({ message: "Pass confirm: true to restore this branch backup." }, 400);
  }
  if (!adminCanAccessBranch(companyId, admin, branchId)) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  const resolved = resolveBackupFile(companyId, branchId, backupId);
  if (!resolved) return c.json({ message: "Backup not found." }, 404);

  try {
    const result = restoreBranchBackup({
      companyId,
      branchId,
      archivePath: resolved.absolutePath,
    });
    return c.json({
      ok: true,
      displayName: result.displayName,
      preRestoreBackupId: result.preRestoreBackupId,
      message: `Restored ${result.displayName}. A safety backup was saved first.`,
    });
  } catch (error) {
    return c.json(
      { message: error instanceof Error ? error.message : "Restore failed." },
      500,
    );
  }
});

/** Upload a previously downloaded backup package into this branch's Backups folder. */
companyRoutes.post("/route47/companies/:companyId/admin/backups/upload", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can upload backups." }, 403);
  }
  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const branchId = c.req.query("branchId")?.trim() ?? "";
  if (!branchId) return c.json({ message: "branchId query parameter is required." }, 400);
  if (!adminCanAccessBranch(companyId, admin, branchId)) {
    return c.json({ message: "You do not have access to this branch." }, 403);
  }

  let tempPath = "";
  try {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!file || typeof file === "string") {
      return c.json({ message: "Upload a .tar.gz backup file as form field \"file\"." }, 400);
    }
    const arrayBuffer = await file.arrayBuffer();
    tempPath = path.join(os.tmpdir(), `route47-upload-${Date.now()}.tar.gz`);
    fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));

    const item = importUploadedBackup({
      companyId,
      branchId,
      tempArchivePath: tempPath,
      originalName: file.name,
    });
    return c.json({ backup: item }, 201);
  } catch (error) {
    return c.json(
      { message: error instanceof Error ? error.message : "Upload failed." },
      400,
    );
  } finally {
    if (tempPath) fs.rmSync(tempPath, { force: true });
  }
});
