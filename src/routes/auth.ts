import crypto from "node:crypto";
import { Hono } from "hono";
import { bearerToken, buildConnectionResponse, createDeviceToken, newDriverDeviceId, resolveDeviceToken, verifyPassword } from "../auth.js";
import { DEMO_SERVER, demoHealthPayload } from "../config.js";
import { db, getCompany } from "../db.js";

type AuthEnv = {
  Variables: {
    companyId: string;
    driverId: string;
    driverDeviceId: string;
    vehicleId: string;
  };
};

export const authRoutes = new Hono();

function publicServerUrl(c: { req: { url: string; header: (name: string) => string | undefined } }) {
  const configured = process.env.ROUTE47_PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  // Behind Render/Railway/Caddy the Node server sees plain HTTP; trust the
  // proxy's X-Forwarded-Proto so drivers get back an https:// server URL.
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  return url.origin;
}

authRoutes.post("/route47/invites/redeem", async (c) => {
  const body = await c.req.json<{
    inviteCode?: string;
    companyId?: string;
    client?: string;
    requestedAtMillis?: number;
  }>();

  const inviteCode = body.inviteCode?.trim() ?? "";
  const requestedCompanyId = body.companyId?.trim() ?? "";

  const invite = db
    .prepare(
      `SELECT code, company_id AS companyId, driver_id AS driverId, vehicle_id AS vehicleId,
              expires_at AS expiresAt, used_at AS usedAt
       FROM invites WHERE code = ?`
    )
    .get(inviteCode) as
    | {
        code: string;
        companyId: string;
        driverId: string | null;
        vehicleId: string;
        expiresAt: number | null;
        usedAt: number | null;
      }
    | undefined;

  if (!invite) {
    return c.json({ message: "Invite code not found." }, 404);
  }

  if (requestedCompanyId && invite.companyId !== requestedCompanyId) {
    return c.json({ message: "Invite code does not match this company." }, 400);
  }

  if (invite.expiresAt && invite.expiresAt < Date.now()) {
    return c.json({ message: "Invite code has expired." }, 410);
  }

  const company = getCompany(invite.companyId);
  if (!company) {
    return c.json({ message: "Company not found for invite." }, 404);
  }

  let driverId = invite.driverId ?? "";
  let driverName = "";
  let vehicleId = invite.vehicleId ?? "";

  if (driverId) {
    const driver = db
      .prepare(
        `SELECT id, display_name AS displayName, vehicle_id AS vehicleId
         FROM drivers WHERE id = ? AND company_id = ?`
      )
      .get(driverId, invite.companyId) as
      | { id: string; displayName: string; vehicleId: string }
      | undefined;

    if (driver) {
      driverName = driver.displayName;
      vehicleId = vehicleId || driver.vehicleId;
    } else {
      driverId = "";
    }
  }

  if (!driverId) {
    driverId = `drv-${invite.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    driverName = driverName || "Invited Driver";
    db.prepare(
      `INSERT OR IGNORE INTO drivers (id, company_id, username, password_hash, display_name, vehicle_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(driverId, invite.companyId, driverId, "invite-only", driverName, vehicleId, Date.now());
  }

  const driverDeviceId = newDriverDeviceId();
  const token = createDeviceToken({
    companyId: invite.companyId,
    driverId,
    driverDeviceId,
    vehicleId,
  });

  db.prepare(`UPDATE invites SET used_at = ? WHERE code = ?`).run(Date.now(), invite.code);

  return c.json(
    buildConnectionResponse({
      message: "Device connected to Route47 demo server.",
      serverUrl: publicServerUrl(c),
      companyId: invite.companyId,
      companyName: company.name,
      driverId,
      driverDeviceId,
      vehicleId,
      driverName,
      deviceAuthToken: token.token,
      deviceAuthTokenExpiresAtMillis: token.expiresAt,
    })
  );
});

authRoutes.post("/route47/drivers/login", async (c) => {
  const body = await c.req.json<{
    username?: string;
    password?: string;
    companyId?: string;
    client?: string;
    requestedAtMillis?: number;
  }>();

  const username = body.username?.trim() ?? "";
  const password = body.password ?? "";
  const requestedCompanyId = body.companyId?.trim() ?? "";

  if (!username || !password) {
    return c.json({ message: "Username and password are required." }, 400);
  }

  const driver = db
    .prepare(
      `SELECT id, company_id AS companyId, username, password_hash AS passwordHash,
              display_name AS displayName, vehicle_id AS vehicleId
       FROM drivers
       WHERE username = ? ${requestedCompanyId ? "AND company_id = ?" : ""}
       LIMIT 1`
    )
    .get(...(requestedCompanyId ? [username, requestedCompanyId] : [username])) as
    | {
        id: string;
        companyId: string;
        username: string;
        passwordHash: string;
        displayName: string;
        vehicleId: string;
      }
    | undefined;

  if (!driver || !verifyPassword(password, driver.passwordHash)) {
    return c.json({ message: "Invalid username or password." }, 401);
  }

  const company = getCompany(driver.companyId);
  if (!company) {
    return c.json({ message: "Company not found." }, 404);
  }

  const driverDeviceId = newDriverDeviceId();
  const token = createDeviceToken({
    companyId: driver.companyId,
    driverId: driver.id,
    driverDeviceId,
    vehicleId: driver.vehicleId,
  });

  return c.json(
    buildConnectionResponse({
      message: "Signed in to Route47 demo server.",
      serverUrl: publicServerUrl(c),
      companyId: driver.companyId,
      companyName: company.name,
      driverId: driver.id,
      driverDeviceId,
      vehicleId: driver.vehicleId,
      driverName: driver.displayName || driver.username,
      deviceAuthToken: token.token,
      deviceAuthTokenExpiresAtMillis: token.expiresAt,
    })
  );
});

export const companyRoutes = new Hono<AuthEnv>();

companyRoutes.use("/route47/companies/:companyId/*", async (c, next) => {
  const path = c.req.path;
  if (path.endsWith("/health")) {
    return next();
  }

  const companyId = c.req.param("companyId");
  const queryCompanyId = c.req.query("companyId")?.trim();
  if (queryCompanyId && queryCompanyId !== companyId) {
    return c.json({ message: "companyId mismatch." }, 400);
  }

  const expectedAdminKey = process.env.ROUTE47_ADMIN_API_KEY ?? DEMO_SERVER.defaultAdminApiKey;
  const bearer = bearerToken(c.req.header("Authorization"));
  const adminKeyHeader = c.req.header("X-Route47-Admin-Key")?.trim();
  const isAdmin =
    adminKeyHeader === expectedAdminKey || bearer === expectedAdminKey;

  if (isAdmin) {
    c.set("companyId", companyId);
    c.set("driverId", c.req.header("X-Route47-Driver-Id") ?? "");
    c.set("driverDeviceId", c.req.header("X-Route47-Device-Id") ?? "");
    c.set("vehicleId", c.req.header("X-Route47-Vehicle-Id") ?? "");
    return next();
  }

  const session = resolveDeviceToken(bearer);
  if (!session) {
    return c.json({ message: "Missing or invalid device auth token." }, 401);
  }

  if (session.companyId !== companyId) {
    return c.json({ message: "Token does not match company." }, 403);
  }

  c.set("companyId", companyId);
  c.set("driverId", session.driverId);
  c.set("driverDeviceId", session.driverDeviceId);
  c.set("vehicleId", session.vehicleId);

  await next();
});

companyRoutes.get("/route47/companies/:companyId/health", (c) => {
  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);

  return c.json(
    demoHealthPayload({
      companyId,
      name: company?.name ?? DEMO_SERVER.defaultCompanyName,
      message: company
        ? `${company.name} demo fleet is online.`
        : "Demo server is online. Use seeded company demo-co for testing.",
    })
  );
});

function requireAdminKey(c: { req: { header: (name: string) => string | undefined } }) {
  const expectedAdminKey = process.env.ROUTE47_ADMIN_API_KEY ?? DEMO_SERVER.defaultAdminApiKey;
  const bearer = bearerToken(c.req.header("Authorization"));
  const adminKeyHeader = c.req.header("X-Route47-Admin-Key")?.trim();
  return adminKeyHeader === expectedAdminKey || bearer === expectedAdminKey;
}

companyRoutes.post("/route47/companies/:companyId/admin/invites", async (c) => {
  if (!requireAdminKey(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const company = getCompany(companyId);
  if (!company) {
    return c.json({ message: "Company not found." }, 404);
  }

  const body = await c.req.json<{
    driverId?: string;
    vehicleId?: string;
    expiresInDays?: number;
  }>();

  const driverId = body.driverId?.trim() || null;
  const vehicleId = body.vehicleId?.trim() ?? "";
  const expiresInDays = Math.min(Math.max(body.expiresInDays ?? 14, 1), 90);
  const now = Date.now();
  const expiresAt = now + expiresInDays * 24 * 60 * 60 * 1000;

  if (driverId) {
    const driver = db
      .prepare(`SELECT id FROM drivers WHERE id = ? AND company_id = ?`)
      .get(driverId, companyId);
    if (!driver) {
      return c.json({ message: "Driver not found for this company." }, 404);
    }
  }

  let inviteCode = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `INV-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const existing = db.prepare(`SELECT code FROM invites WHERE code = ?`).get(candidate);
    if (!existing) {
      inviteCode = candidate;
      break;
    }
  }

  if (!inviteCode) {
    return c.json({ message: "Could not generate a unique invite code." }, 500);
  }

  db.prepare(
    `INSERT INTO invites (code, company_id, driver_id, vehicle_id, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(inviteCode, companyId, driverId, vehicleId, expiresAt, now);

  return c.json({
    message: "Driver invite created.",
    inviteCode,
    companyId,
    driverId,
    vehicleId,
    expiresAtMillis: expiresAt,
  });
});
