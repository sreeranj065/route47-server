import { Hono } from "hono";
import { cors } from "hono/cors";
import { DEMO_SERVER, demoHealthPayload } from "./config.js";
import { authRoutes, companyRoutes } from "./routes/auth.js";
import "./routes/live.js";
import "./routes/plans-geofences.js";
import "./routes/proofs.js";
import "./routes/admin-fleet.js";

export const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Route47-Server-Mode", DEMO_SERVER.deploymentMode);
  c.header("X-Route47-Server-Name", DEMO_SERVER.name);
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

app.get("/health", (c) => c.json(demoHealthPayload()));

// Minimal unauthenticated probe for hosting platforms (Render healthCheckPath,
// Railway healthcheck). /health stays as the richer payload used by the apps.
app.get("/healthz", (c) =>
  c.json({ ok: true, version: DEMO_SERVER.version })
);

app.route("/", authRoutes);
app.route("/", companyRoutes);

app.notFound((c) => c.json({ message: `Not found: ${c.req.method} ${c.req.path}` }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ message: error.message || "Internal server error." }, 500);
});
