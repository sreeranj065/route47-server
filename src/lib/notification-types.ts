/** Scalable notification type registry — add new types here without schema changes. */
export const NOTIFICATION_TYPES = {
  CURRENT_LIST_ASSIGNED: "current_list.assigned",
  CURRENT_LIST_UPDATED: "current_list.updated",
  STOPS_CHANGED: "stops.changed",
  ROUTE_ASSIGNED: "route.assigned",
  ROUTE_REASSIGNED: "route.reassigned",
  ROUTE_CANCELLED: "route.cancelled",
  ROUTE_STARTED: "route.started",
  ROUTE_COMPLETED: "route.completed",
  POD_UPLOADED: "pod.uploaded",
  RECEIPT_UPLOADED: "receipt.uploaded",
  ISSUE_REPORTED: "issue.reported",
  ADMIN_ANNOUNCEMENT: "admin.announcement",
  LICENSE_NOTICE: "license.notice",
  MESSAGE: "message.incoming",
  SYNC_SILENT: "sync.silent",
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export type RecipientType = "driver" | "admin";

export type NotificationPriority = "low" | "normal" | "high";

export type NotificationCategory =
  | "routes"
  | "proofs"
  | "drivers"
  | "announcements"
  | "system"
  | "billing";

export const TYPE_CATEGORY: Record<string, NotificationCategory> = {
  [NOTIFICATION_TYPES.CURRENT_LIST_ASSIGNED]: "routes",
  [NOTIFICATION_TYPES.CURRENT_LIST_UPDATED]: "routes",
  [NOTIFICATION_TYPES.STOPS_CHANGED]: "routes",
  [NOTIFICATION_TYPES.ROUTE_ASSIGNED]: "routes",
  [NOTIFICATION_TYPES.ROUTE_REASSIGNED]: "routes",
  [NOTIFICATION_TYPES.ROUTE_CANCELLED]: "routes",
  [NOTIFICATION_TYPES.ROUTE_STARTED]: "drivers",
  [NOTIFICATION_TYPES.ROUTE_COMPLETED]: "drivers",
  [NOTIFICATION_TYPES.POD_UPLOADED]: "proofs",
  [NOTIFICATION_TYPES.RECEIPT_UPLOADED]: "proofs",
  [NOTIFICATION_TYPES.ISSUE_REPORTED]: "drivers",
  [NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT]: "announcements",
  [NOTIFICATION_TYPES.LICENSE_NOTICE]: "billing",
  [NOTIFICATION_TYPES.MESSAGE]: "system",
  [NOTIFICATION_TYPES.SYNC_SILENT]: "system",
};
