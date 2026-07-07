import type { AdminIdentity } from "./admin-auth.js";

type AdminContext = {
  get: (key: "admin") => AdminIdentity | undefined;
};

export function hasAdminAccess(c: AdminContext): boolean {
  return c.get("admin") != null;
}

export function getAdminIdentity(c: AdminContext): AdminIdentity | null {
  return c.get("admin") ?? null;
}
