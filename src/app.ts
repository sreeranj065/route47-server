import { Hono } from "hono";
import { cors } from "hono/cors";
import { SERVER_CONFIG, buildHealthPayload } from "./config.js";
import { authRoutes, companyRoutes } from "./routes/auth.js";
import "./routes/live.js";
import "./routes/plans-geofences.js";
import "./routes/proofs.js";
import "./routes/admin-fleet.js";
import { migrateFlatProofPaths } from "./proof-migration.js";

try {
  const migratedProofs = migrateFlatProofPaths();
  if (migratedProofs > 0) {
    console.log(`Migrated ${migratedProofs} flat proof file(s) into folder layout.`);
  }
} catch (error) {
  console.warn("Proof path migration skipped:", error);
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
    exposeHeaders: ["X-Route47-Server-Mode", "X-Route47-Server-Name"],
  })
);

app.get("/health", (c) => c.json(buildHealthPayload()));

// Minimal unauthenticated probe for hosting platforms (Render healthCheckPath,
// Railway healthcheck). /health stays as the richer payload used by the apps.
app.get("/healthz", (c) =>
  c.json({ ok: true, version: SERVER_CONFIG.version })
);

app.route("/", authRoutes);
app.route("/", companyRoutes);

app.notFound((c) => c.json({ message: `Not found: ${c.req.method} ${c.req.path}` }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ message: error.message || "Internal server error." }, 500);
});
