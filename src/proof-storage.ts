import path from "node:path";
import { PROOFS_DIR } from "./db.js";

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
  proofId: string;
  proofType: string;
  routeRunId: string;
  originalFileName: string;
}): { storedPath: string; storedName: string; relativePath: string } {
  const folder = buildProofFolderName(params.proofType);
  const routeFolder = sanitizePathSegment(params.routeRunId, "unassigned");
  const ext = path.extname(params.originalFileName) || ".bin";
  const storedName =
    path.basename(params.originalFileName).trim() ||
    `${sanitizePathSegment(params.proofId, "proof")}${ext}`;

  const relativePath = path.posix.join(routeFolder, folder, storedName);
  const storedPath = path.join(PROOFS_DIR, params.companyId, relativePath);

  return { storedPath, storedName, relativePath };
}
