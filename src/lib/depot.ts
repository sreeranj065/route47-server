import { db } from "../db.js";
import { getDriverBranchId } from "../branch-storage.js";
import {
  ensureDefaultBranch,
  type BranchRow,
} from "./admin-auth.js";

export type DriverDepotPayload = {
  branchId: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  regionCode: string;
  regionName: string;
};

function hasCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (latitude == null || longitude == null) return false;
  return latitude !== 0 || longitude !== 0;
}

function inferDepotRegion(
  latitude: number | null,
  longitude: number | null,
  address: string,
): { regionCode: string; regionName: string } {
  if (latitude != null && longitude != null) {
    if (
      latitude >= 41 &&
      latitude <= 84 &&
      longitude >= -141 &&
      longitude <= -52
    ) {
      return { regionCode: "ca", regionName: "Canada" };
    }
    if (
      latitude >= 24 &&
      latitude <= 50 &&
      longitude >= -125 &&
      longitude <= -66
    ) {
      return { regionCode: "us", regionName: "United States" };
    }
  }

  const lower = address.toLowerCase();
  if (
    lower.includes("canada") ||
    lower.includes("ontario") ||
    lower.includes("quebec") ||
    lower.includes("british columbia") ||
    lower.includes("alberta") ||
    lower.includes("toronto") ||
    lower.includes("vancouver") ||
    lower.includes("montreal")
  ) {
    return { regionCode: "ca", regionName: "Canada" };
  }

  if (
    lower.includes("united states") ||
    lower.includes(" usa") ||
    lower.endsWith(" usa") ||
    lower.includes("california") ||
    lower.includes("texas") ||
    lower.includes("new york")
  ) {
    return { regionCode: "us", regionName: "United States" };
  }

  return { regionCode: "", regionName: "" };
}

function loadBranch(companyId: string, branchId: string): BranchRow {
  const row = db
    .prepare(`SELECT * FROM company_branches WHERE company_id = ? AND id = ?`)
    .get(companyId, branchId) as BranchRow | undefined;
  return row ?? ensureDefaultBranch(companyId);
}

/** Resolve the depot a driver should use, falling back to the primary branch coords. */
export function resolveDriverDepot(
  companyId: string,
  driverId: string,
): DriverDepotPayload | null {
  const sessionDriverId = driverId.trim();
  if (!sessionDriverId) return null;

  const branchId = getDriverBranchId(companyId, sessionDriverId);
  const branch = loadBranch(companyId, branchId);
  const primary = ensureDefaultBranch(companyId);

  const address =
    branch.address?.trim() ||
    primary.address?.trim() ||
    "";
  const name = branch.name?.trim() || primary.name?.trim() || "Head Office";

  let latitude = branch.latitude ?? null;
  let longitude = branch.longitude ?? null;
  if (!hasCoordinates(latitude, longitude) && hasCoordinates(primary.latitude, primary.longitude)) {
    latitude = primary.latitude;
    longitude = primary.longitude;
  }

  const region = inferDepotRegion(latitude, longitude, address);

  return {
    branchId: branch.id,
    name,
    address,
    latitude,
    longitude,
    regionCode: region.regionCode,
    regionName: region.regionName,
  };
}
