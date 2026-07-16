import { getCompany } from "../db.js";
import { SERVER_VERSION } from "../config.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import {
  checkUpstreamRepoStatus,
  getSelfUpdateConfig,
  readSelfUpdateState,
  triggerPaaSUpdate,
  triggerSelfUpdate,
} from "../lib/server-self-update.js";
import {
  maskSecret,
  readStoredUpdateCredentials,
  writeStoredUpdateCredentials,
} from "../lib/update-credentials-store.js";
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
    railwayConfigured: config.railwayConfigured,
    inAppUpdateSupported: config.inAppUpdateSupported,
    updateStatus: state.status,
    updateMessage: state.message,
    startedAtMillis: state.startedAt,
    completedAtMillis: state.completedAt,
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/server/update-credentials", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const stored = readStoredUpdateCredentials();
  const config = getSelfUpdateConfig();

  return c.json({
    hostingMode: config.hostingMode,
    inAppUpdateSupported: config.inAppUpdateSupported,
    railwayConfigured: config.railwayConfigured,
    deployHookConfigured: config.deployHookConfigured,
    selfUpdateSupported: config.supported,
    stored: {
      hostingMode: stored.hostingMode ?? null,
      railwayApiTokenMasked: maskSecret(stored.railwayApiToken),
      railwayServiceId: stored.railwayServiceId ?? null,
      railwayEnvironmentId: stored.railwayEnvironmentId ?? null,
      deployHookUrlMasked: maskSecret(stored.deployHookUrl),
      updatedAtMillis: stored.updatedAtMillis ?? null,
    },
  });
});

companyRoutes.put("/route47/companies/:companyId/admin/server/update-credentials", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Only owners and admins can change update settings." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req.json<{
    hostingMode?: "railway" | "render" | "vps" | "docker" | "development";
    railwayApiToken?: string;
    railwayServiceId?: string;
    railwayEnvironmentId?: string;
    deployHookUrl?: string;
  }>();

  writeStoredUpdateCredentials({
    hostingMode: body.hostingMode,
    railwayApiToken: body.railwayApiToken?.trim(),
    railwayServiceId: body.railwayServiceId?.trim(),
    railwayEnvironmentId: body.railwayEnvironmentId?.trim(),
    deployHookUrl: body.deployHookUrl?.trim(),
  });

  const config = getSelfUpdateConfig();
  return c.json({
    message: config.inAppUpdateSupported
      ? "One-tap updates are ready. Use Check for updates in Settings → Server."
      : "Saved. Add the missing Railway or Render details to finish enabling updates.",
    inAppUpdateSupported: config.inAppUpdateSupported,
    railwayConfigured: config.railwayConfigured,
    deployHookConfigured: config.deployHookConfigured,
    selfUpdateSupported: config.supported,
    hostingMode: config.hostingMode,
  });
});

/** Equivalent of Railway Upstream → Check for updates (GitHub main vs last applied). */
companyRoutes.get("/route47/companies/:companyId/admin/server/upstream-check", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const config = getSelfUpdateConfig();
  const upstream = await checkUpstreamRepoStatus(SERVER_VERSION);

  return c.json({
    ...upstream,
    hostingMode: config.hostingMode,
    selfUpdateSupported: config.supported,
    deployHookConfigured: config.deployHookConfigured,
    railwayConfigured: config.railwayConfigured,
    inAppUpdateSupported: config.inAppUpdateSupported,
    deployedVersion: SERVER_VERSION,
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

  // Prefer Docker/VPS self-update when available.
  if (config.supported) {
    const result = triggerSelfUpdate();
    if (!result.started) {
      return c.json(
        {
          message: result.message,
          selfUpdateSupported: true,
          deployHookConfigured: config.deployHookConfigured,
          railwayConfigured: config.railwayConfigured,
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
        railwayConfigured: config.railwayConfigured,
        inAppUpdateSupported: true,
        updateStatus: "running",
        mode: "docker_self_update",
      },
      202,
    );
  }

  if (config.deployHookConfigured || config.railwayConfigured) {
    const result = await triggerPaaSUpdate();
    if (!result.started) {
      return c.json(
        {
          message: result.message,
          selfUpdateSupported: false,
          deployHookConfigured: config.deployHookConfigured,
          railwayConfigured: config.railwayConfigured,
          inAppUpdateSupported: config.inAppUpdateSupported,
          updateStatus: result.status ?? "failed",
        },
        409,
      );
    }

    return c.json(
      {
        message: result.message,
        selfUpdateSupported: false,
        deployHookConfigured: config.deployHookConfigured,
        railwayConfigured: config.railwayConfigured,
        inAppUpdateSupported: true,
        updateStatus: result.status ?? "success",
        mode: result.mode ?? "paas",
        status: "deploy_triggered",
      },
      202,
    );
  }

  return c.json(
    {
      message:
        "In-app update is not configured. Render: set ROUTE47_DEPLOY_HOOK_URL. Railway: set ROUTE47_RAILWAY_API_TOKEN, ROUTE47_RAILWAY_SERVICE_ID, and ROUTE47_RAILWAY_ENVIRONMENT_ID. Docker/VPS: enable ROUTE47_SELF_UPDATE_ENABLED.",
      selfUpdateSupported: false,
      deployHookConfigured: false,
      railwayConfigured: false,
      inAppUpdateSupported: false,
      hostingMode: config.hostingMode,
    },
    501,
  );
});
