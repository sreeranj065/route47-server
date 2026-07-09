import path from "node:path";
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

export function buildStoredProofPath(params: {
  companyId: string;
  branchId: string;
  proofId: string;
  proofType: string;
  routeRunId: string;
  originalFileName: string;
}): { storedPath: string; storedName: string; relativePath: string } {
  const folder = buildProofFolderName(params.proofType);
  const category = proofFolderToOperationalCategory(folder);
  const routeFolder = sanitizePathSegment(params.routeRunId, "unassigned");
  const ext = path.extname(params.originalFileName) || ".bin";
  const storedName =
    path.basename(params.originalFileName).trim() ||
    `${sanitizePathSegment(params.proofId, "proof")}${ext}`;

  const branchRoot = ensureBranchOperationalLayout(params.companyId, params.branchId);
  const relativePath = path.posix.join(category, routeFolder, storedName);
  const storedPath = path.join(branchRoot, category, routeFolder, storedName);

  return { storedPath, storedName, relativePath };
}
