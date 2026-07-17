import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { SERVER_CONFIG, SERVER_VERSION } from "./config.js";
import { DATA_DIR, DB_PATH } from "./db.js";
import { startBackupScheduler } from "./lib/backup-scheduler.js";

function resolvePort(): number {
  const raw = process.env.PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    console.warn(`Invalid PORT="${raw}", falling back to 4700`);
  }
  return 4700;
}

const port = resolvePort();
const hostname = process.env.HOST ?? "0.0.0.0";

console.log(`${SERVER_CONFIG.name} v${SERVER_VERSION}`);
console.log(`Listening on http://${hostname}:${port}`);
console.log(`Data directory: ${DATA_DIR}`);
console.log(`Database: ${DB_PATH}`);

if (!process.env.ROUTE47_ADMIN_API_KEY?.trim()) {
  console.warn("");
  console.warn("ROUTE47_ADMIN_API_KEY is not set — admin API endpoints will reject all requests.");
  console.warn("Set ROUTE47_ADMIN_API_KEY before connecting the Admin app.");
}

console.log("");
console.log("Driver app requires HTTPS. For local testing:");
console.log(`  ngrok http ${port}`);
console.log("  set ROUTE47_PUBLIC_URL=https://your-ngrok-url");

serve({ fetch: app.fetch, port, hostname });
startBackupScheduler();
