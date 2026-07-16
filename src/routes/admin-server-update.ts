import { getCompany } from "../db.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import {
  getSelfUpdateConfig,
  readSelfUpdateState,
  triggerDeployHook,
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
    deployHookConfigured: config.deployHookConfigured,
    inAppUpdateSupported: config.inAppUpdateSupported,
    updateStatus: state.status,
    updateMessage: state.message,
    startedAtMillis: state.startedAt,
    completedAtMillis: state.completedAt,
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/server/update", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can update the server." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const config = getSelfUpdateConfig();

  // Prefer Docker/VPS self-update when available; otherwise PaaS deploy hook.
  if (config.supported) {
    const result = triggerSelfUpdate();
    if (!result.started) {
      return c.json(
        {
          message: result.message,
          selfUpdateSupported: true,
          deployHookConfigured: config.deployHookConfigured,
          inAppUpdateSupported: config.inAppUpdateSupported,
        },
        409,
      );
    }

    return c.json(
      {
        message: result.message,
        selfUpdateSupported: true,
        deployHookConfigured: config.deployHookConfigured,
        inAppUpdateSupported: true,
        updateStatus: "running",
        mode: "docker_self_update",
      },
      202,
    );
  }

  if (config.deployHookConfigured) {
    const result = await triggerDeployHook();
    if (!result.started) {
      return c.json(
        {
          message: result.message,
          selfUpdateSupported: false,
          deployHookConfigured: true,
          inAppUpdateSupported: true,
          updateStatus: result.status ?? "failed",
        },
        409,
      );
    }

    return c.json(
      {
        message: result.message,
        selfUpdateSupported: false,
        deployHookConfigured: true,
        inAppUpdateSupported: true,
        updateStatus: result.status ?? "success",
        mode: "deploy_hook",
        status: "deploy_triggered",
      },
      202,
    );
  }

  return c.json(
    {
      message:
        "In-app update is not configured. On Docker/VPS enable ROUTE47_SELF_UPDATE_ENABLED; on Railway/Render set ROUTE47_DEPLOY_HOOK_URL to your Deploy Hook.",
      selfUpdateSupported: false,
      deployHookConfigured: false,
      inAppUpdateSupported: false,
      hostingMode: config.hostingMode,
    },
    501,
  );
});
