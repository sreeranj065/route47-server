import { getCompany } from "../db.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import {
  getSelfUpdateConfig,
  readSelfUpdateState,
  triggerSelfUpdate,
} from "../lib/server-self-update.js";
import { companyRoutes } from "./auth.js";

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

companyRoutes.get("/route47/companies/:companyId/admin/server/update-capabilities", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const config = getSelfUpdateConfig();
  const state = readSelfUpdateState();

  return c.json({
    hostingMode: config.hostingMode,
    selfUpdateSupported: config.supported,
    updateStatus: state.status,
    updateMessage: state.message,
    startedAtMillis: state.startedAt,
    completedAtMillis: state.completedAt,
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/server/update", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can update the server." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const config = getSelfUpdateConfig();
  if (!config.supported) {
    return c.json(
      {
        message:
          "In-app update is only available on Docker/VPS installs with self-update enabled. Use your hosting provider dashboard instead.",
        selfUpdateSupported: false,
        hostingMode: config.hostingMode,
      },
      501,
    );
  }

  const result = triggerSelfUpdate();
  if (!result.started) {
    return c.json({ message: result.message, selfUpdateSupported: true }, 409);
  }

  return c.json(
    {
      message: result.message,
      selfUpdateSupported: true,
      updateStatus: "running",
    },
    202,
  );
});
