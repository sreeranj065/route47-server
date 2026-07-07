import { db } from "../db.js";
import { NOTIFICATION_TYPES } from "./notification-types.js";
import { notifyAllAdmins, notifyDriver } from "./notification-service.js";

function driverDisplayName(companyId: string, driverId: string): string {
  if (!driverId) return "Driver";
  const row = db
    .prepare(`SELECT display_name AS displayName, username FROM drivers WHERE company_id = ? AND id = ?`)
    .get(companyId, driverId) as { displayName?: string; username?: string } | undefined;
  return row?.displayName?.trim() || row?.username?.trim() || driverId;
}

export function notifyRoutePlanPublished(input: {
  companyId: string;
  routeRunId: string;
  driverId: string;
  previousDriverId?: string;
  stopCount: number;
  isNew: boolean;
}) {
  const { companyId, routeRunId, driverId, stopCount } = input;
  const driverName = driverDisplayName(companyId, driverId);

  if (!driverId) return;

  if (input.isNew) {
    notifyDriver(
      companyId,
      driverId,
      NOTIFICATION_TYPES.CURRENT_LIST_ASSIGNED,
      "New current list assigned",
      `You have ${stopCount} stop${stopCount === 1 ? "" : "s"} on your current list.`,
      { routeRunId, stopCount: String(stopCount) },
      { priority: "high" },
    );
    notifyAllAdmins(
      companyId,
      NOTIFICATION_TYPES.ROUTE_ASSIGNED,
      "Route assigned",
      `${driverName} was assigned a route with ${stopCount} stop${stopCount === 1 ? "" : "s"}.`,
      { routeRunId, driverId, stopCount: String(stopCount) },
    );
    return;
  }

  const previousDriverId = input.previousDriverId?.trim() ?? "";
  if (previousDriverId && previousDriverId !== driverId) {
    notifyDriver(
      companyId,
      previousDriverId,
      NOTIFICATION_TYPES.ROUTE_CANCELLED,
      "Route reassigned",
      "Your current list was reassigned to another driver.",
      { routeRunId },
    );
    notifyDriver(
      companyId,
      driverId,
      NOTIFICATION_TYPES.ROUTE_REASSIGNED,
      "Route assigned to you",
      `You now have ${stopCount} stop${stopCount === 1 ? "" : "s"} on your current list.`,
      { routeRunId, stopCount: String(stopCount) },
      { priority: "high" },
    );
    notifyAllAdmins(
      companyId,
      NOTIFICATION_TYPES.ROUTE_REASSIGNED,
      "Route reassigned",
      `${driverName} was reassigned a route (${stopCount} stops).`,
      { routeRunId, driverId, stopCount: String(stopCount) },
    );
    return;
  }

  notifyDriver(
    companyId,
    driverId,
    NOTIFICATION_TYPES.CURRENT_LIST_UPDATED,
    "Current list updated",
    `Your current list now has ${stopCount} stop${stopCount === 1 ? "" : "s"}.`,
    { routeRunId, stopCount: String(stopCount) },
  );
  notifyAllAdmins(
    companyId,
    NOTIFICATION_TYPES.STOPS_CHANGED,
    "Current list updated",
    `${driverName}'s current list was updated (${stopCount} stops).`,
    { routeRunId, driverId, stopCount: String(stopCount) },
  );
}

export function notifyRoutePlanRemoved(companyId: string, driverId: string, routeRunId: string) {
  if (!driverId) return;
  notifyDriver(
    companyId,
    driverId,
    NOTIFICATION_TYPES.ROUTE_CANCELLED,
    "Route cancelled",
    "Your current list was removed by dispatch.",
    { routeRunId },
    { priority: "high" },
  );
  notifyAllAdmins(
    companyId,
    NOTIFICATION_TYPES.ROUTE_CANCELLED,
    "Route cancelled",
    `${driverDisplayName(companyId, driverId)}'s route was cancelled.`,
    { routeRunId, driverId },
  );
}

export function notifyProofUploaded(input: {
  companyId: string;
  driverId: string;
  proofType: string;
  customerName: string;
  routeRunId: string;
  stopId: string;
}) {
  const driverName = driverDisplayName(input.companyId, input.driverId);
  const normalized = input.proofType.toLowerCase();
  const isReceipt = normalized.includes("receipt");
  const type = isReceipt ? NOTIFICATION_TYPES.RECEIPT_UPLOADED : NOTIFICATION_TYPES.POD_UPLOADED;
  const label = isReceipt ? "Receipt uploaded" : "POD uploaded";

  notifyAllAdmins(
    input.companyId,
    type,
    label,
    `${driverName} uploaded a ${isReceipt ? "receipt" : "POD"}${input.customerName ? ` for ${input.customerName}` : ""}.`,
    {
      driverId: input.driverId,
      routeRunId: input.routeRunId,
      stopId: input.stopId,
      proofType: input.proofType,
    },
    { priority: "high" },
  );
}

export function notifyActivityEvents(
  companyId: string,
  events: Array<{ driverId: string; routeId?: string; stopId?: string; eventType?: string }>,
) {
  for (const event of events) {
    const driverId = event.driverId?.trim();
    if (!driverId) continue;
    const eventType = (event.eventType ?? "").trim().toUpperCase();
    const driverName = driverDisplayName(companyId, driverId);
    const routeId = event.routeId ?? "";
    const stopId = event.stopId ?? "";

    if (eventType === "ROUTE_STARTED" || eventType === "SHIFT_STARTED") {
      notifyAllAdmins(
        companyId,
        NOTIFICATION_TYPES.ROUTE_STARTED,
        "Driver started route",
        `${driverName} started their route.`,
        { driverId, routeRunId: routeId },
      );
    } else if (eventType === "ROUTE_COMPLETED" || eventType === "SHIFT_ENDED") {
      notifyAllAdmins(
        companyId,
        NOTIFICATION_TYPES.ROUTE_COMPLETED,
        "Driver completed route",
        `${driverName} completed their route.`,
        { driverId, routeRunId: routeId },
      );
    } else if (eventType.includes("ISSUE") || eventType === "STOP_FAILED") {
      notifyAllAdmins(
        companyId,
        NOTIFICATION_TYPES.ISSUE_REPORTED,
        "Driver reported an issue",
        `${driverName} reported an issue${stopId ? ` at stop ${stopId}` : ""}.`,
        { driverId, routeRunId: routeId, stopId, eventType },
        { priority: "high" },
      );
    }
  }
}

export function notifySilentSync(companyId: string, driverId: string, routeRunId: string) {
  notifyDriver(
    companyId,
    driverId,
    NOTIFICATION_TYPES.SYNC_SILENT,
    "",
    "",
    { routeRunId, action: "sync" },
    { silent: true },
  );
}
