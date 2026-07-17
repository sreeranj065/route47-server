import { Hono } from "hono";
import { cors } from "hono/cors";
import { SERVER_CONFIG, buildHealthPayload } from "./config.js";
import { authRoutes, companyRoutes } from "./routes/auth.js";
import "./routes/live.js";
import "./routes/plans-geofences.js";
import "./routes/proofs.js";
import "./routes/admin-fleet.js";
import "./routes/business-search.js";
import "./routes/admin-team.js";
import "./routes/notifications.js";
import "./routes/messages.js";
import "./routes/branch-sharing.js";
import { ensureDriverDeviceActivatedColumn } from "./lib/branch-filter.js";
import "./lib/branch-filter.js";
import { adminInviteRoutes } from "./routes/admin-team.js";
import "./routes/admin-server-update.js";
import "./routes/admin-backups.js";
import { migrateFlatProofPaths } from "./proof-migration.js";
import { migrateMessageAttachmentPaths } from "./message-attachment-migration.js";

ensureDriverDeviceActivatedColumn();

try {
  const migratedProofs = migrateFlatProofPaths();
  if (migratedProofs > 0) {
    console.log(`Migrated ${migratedProofs} flat proof file(s) into folder layout.`);
  }
} catch (error) {
  console.warn("Proof path migration skipped:", error);
}

try {
  const migratedAttachments = migrateMessageAttachmentPaths();
  if (migratedAttachments > 0) {
    console.log(`Migrated ${migratedAttachments} message attachment(s) into branch folders.`);
  }
} catch (error) {
  console.warn("Message attachment migration skipped:", error);
}

export const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Route47-Server-Mode", SERVER_CONFIG.deploymentMode);
  c.header("X-Route47-Server-Name", SERVER_CONFIG.name);
});

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "X-Route47-Company-Id",
      "X-Route47-Driver-Id",
      "X-Route47-Device-Id",
      "X-Route47-Vehicle-Id",
      "X-Route47-Admin-Key",
      "X-Client",
    ],
    exposeHeaders: [
      "X-Route47-Server-Mode",
      "X-Route47-Server-Name",
      "Content-Type",
      "Content-Disposition",
    ],
  })
);

app.get("/health", (c) => c.json(buildHealthPayload()));

// Minimal unauthenticated probe for hosting platforms (Render healthCheckPath,
// Railway healthcheck). /health stays as the richer payload used by the apps.
app.get("/healthz", (c) => {
  const selfUpdateSupported =
    process.env.ROUTE47_SELF_UPDATE_ENABLED === "true" &&
    (SERVER_CONFIG.hostingMode === "docker" || SERVER_CONFIG.hostingMode === "vps");
  const deployHookConfigured = Boolean(process.env.ROUTE47_DEPLOY_HOOK_URL?.trim());
  const railwayConfigured = Boolean(
    process.env.ROUTE47_RAILWAY_API_TOKEN?.trim() &&
      process.env.ROUTE47_RAILWAY_SERVICE_ID?.trim() &&
      process.env.ROUTE47_RAILWAY_ENVIRONMENT_ID?.trim(),
  );
  return c.json({
    ok: true,
    version: SERVER_CONFIG.version,
    hostingMode: SERVER_CONFIG.hostingMode,
    selfUpdateSupported,
    deployHookConfigured,
    railwayConfigured,
    inAppUpdateSupported: selfUpdateSupported || deployHookConfigured || railwayConfigured,
  });
});

app.route("/", authRoutes);
app.route("/", companyRoutes);
app.route("/", adminInviteRoutes);

app.notFound((c) => c.json({ message: `Not found: ${c.req.method} ${c.req.path}` }, 404));

app.onError((error, c) => {
  console.error(error);
  // Raw JSON SyntaxError messages ("Unexpected token…", "syntax error") used
  // to leak straight into the apps' sync status lines. Return something a
  // fleet admin can act on instead, and keep the full error in server logs.
  const message =
    error instanceof SyntaxError
      ? "Invalid request payload (malformed JSON). Please retry the sync."
      : error.message || "Internal server error.";
  return c.json({ message }, 500);
});
