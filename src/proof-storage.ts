import path from "node:path";
import { db } from "./db.js";
import {
  ensureBranchOperationalLayout,
  proofFolderToOperationalCategory,
} from "./branch-storage.js";

/** Aligns with Driver `ProofFileNameBuilder.buildProofFolderName()`. */
export function buildProofFolderName(proofType: string): string {
  const normalized = proofType.trim().toUpperCase();
  if (!normalized) return "OTHER";

  if (normalized.includes("POD") || normalized.includes("DELIVERY_RECEIPT")) {
    return "POD";
  }
  if (
    normalized.includes("PICKUP") ||
    normalized.includes("BILL_OF_LADING") ||
    normalized.includes("PACKING_SLIP")
  ) {
    return "PICKUP";
  }
  if (normalized.includes("FUEL") || normalized.includes("SERVICE_RECEIPT")) {
    return "RECEIPTS";
  }
  if (normalized.includes("RECEIPT")) {
    return "RECEIPTS";
  }
  return "OTHER";
}

export function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

export function resolveDriverFolderName(companyId: string, driverId: string): string {
  const trimmed = driverId.trim();
  if (!trimmed) return "Unknown_Driver";

  const row = db
    .prepare(
      `SELECT display_name AS displayName FROM drivers WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, trimmed) as { displayName?: string } | undefined;

  const display = row?.displayName?.trim();
  if (display) {
    return sanitizePathSegment(display, trimmed);
  }
  return sanitizePathSegment(trimmed, "Unknown_Driver");
}

/**
 * Layout: operational/{Company}/{Branch}/{Category}/{DriverName}/{routeRunId}/{file}
 */
export function buildStoredProofPath(params: {
  companyId: string;
  branchId: string;
  proofId: string;
  proofType: string;
  routeRunId: string;
  originalFileName: string;
  driverId?: string;
  driverFolderName?: string;
}): { storedPath: string; storedName: string; relativePath: string } {
  const folder = buildProofFolderName(params.proofType);
  const category = proofFolderToOperationalCategory(folder);
  const routeFolder = sanitizePathSegment(params.routeRunId, "unassigned");
  const driverFolder =
    params.driverFolderName?.trim() ||
    resolveDriverFolderName(params.companyId, params.driverId ?? "");
  const ext = path.extname(params.originalFileName) || ".bin";
  const storedName =
    path.basename(params.originalFileName).trim() ||
    `${sanitizePathSegment(params.proofId, "proof")}${ext}`;

  const branchRoot = ensureBranchOperationalLayout(params.companyId, params.branchId);
  const relativePath = path.posix.join(category, driverFolder, routeFolder, storedName);
  const storedPath = path.join(branchRoot, category, driverFolder, routeFolder, storedName);

  return { storedPath, storedName, relativePath };
}
