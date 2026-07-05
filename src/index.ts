import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { DEMO_SERVER, SERVER_VERSION } from "./config.js";
import { DATA_DIR, DB_PATH } from "./db.js";
import { seedDemoData } from "./seed.js";

// Render/Railway inject PORT; 4700 is the local dev default.
const port = Number(process.env.PORT ?? 4700);
// Bind all interfaces so the server is reachable inside containers.
const hostname = process.env.HOST ?? "0.0.0.0";

seedDemoData();

console.log(`${DEMO_SERVER.name} v${SERVER_VERSION}`);
console.log(DEMO_SERVER.purpose);
console.log(`Listening on http://${hostname}:${port}`);
console.log(`Data directory: ${DATA_DIR}`);
console.log(`Database: ${DB_PATH}`);
console.log("");
console.log("Seeded demo fleet:");
console.log(`  company: ${DEMO_SERVER.defaultCompanyId}`);
console.log(`  driver:  ${DEMO_SERVER.defaultDriverUsername} / ${DEMO_SERVER.defaultDriverPassword}`);
console.log(`  invite:  ${DEMO_SERVER.defaultInviteCode}`);
console.log("  admin:   X-Route47-Admin-Key (set ROUTE47_ADMIN_API_KEY in production)");
console.log("");
console.log("Production fleets use a customer-owned Route47 Customer Server (see CUSTOMER_SERVER.md).");
console.log("");
console.log("Driver app requires HTTPS. For local testing:");
console.log(`  ngrok http ${port}`);
console.log("  set ROUTE47_PUBLIC_URL=https://your-ngrok-url");

serve({ fetch: app.fetch, port, hostname });
