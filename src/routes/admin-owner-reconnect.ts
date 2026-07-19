import { Hono } from "hono";
import { companyRoutes } from "./auth.js";
import { hasAdminAccess } from "../lib/route-admin.js";
import {
  bindCompanyOwner,
  claimOwnerDeviceKey,
  getOwnerBinding,
} from "../lib/owner-reconnect.js";
import { isFirebaseAdminConfigured } from "../lib/firebase-admin-app.js";

function requireOwner(c: {
  get: (key: "admin") => import("../lib/admin-auth.js").AdminIdentity | undefined;
}) {
  const admin = c.get("admin");
  return Boolean(admin && admin.role === "owner");
}

/** Bind Firebase account → company owner (call after first successful API-key connect). */
companyRoutes.post("/route47/companies/:companyId/admin/owner/bind", async (c) => {
  if (!hasAdminAccess(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }
  if (!requireOwner(c)) {
    return c.json({ message: "Only the company owner can link a Route47 account." }, 403);
  }

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{ idToken?: string }>().catch(() => ({} as { idToken?: string }));
  const idToken = body.idToken?.trim() ?? "";
  if (!idToken) {
    return c.json({ message: "idToken is required." }, 400);
  }

  const result = await bindCompanyOwner({ companyId, idToken });
  if (!result.ok) {
    return c.json({ message: result.message }, result.status as 401 | 404 | 409);
  }

  return c.json({
    message: result.alreadyBound ? "Owner account already linked." : "Owner account linked for reconnect.",
    firebaseUid: result.firebaseUid,
    email: result.email,
    alreadyBound: result.alreadyBound,
    firebaseConfigured: isFirebaseAdminConfigured(),
  });
});

companyRoutes.get("/route47/companies/:companyId/admin/owner/binding", async (c) => {
  if (!hasAdminAccess(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }
  const companyId = c.req.param("companyId");
  const binding = getOwnerBinding(companyId);
  return c.json({
    bound: Boolean(binding),
    email: binding?.boundEmail || undefined,
    firebaseConfigured: isFirebaseAdminConfigured(),
  });
});

/** Unauthenticated claim — Firebase ID token proves ownership after bind. */
export const ownerClaimRoutes = new Hono();

ownerClaimRoutes.post("/route47/admin/owner/claim", async (c) => {
  const body = await c.req
    .json<{ idToken?: string; companyId?: string }>()
    .catch(() => ({} as { idToken?: string; companyId?: string }));

  const idToken = body.idToken?.trim() ?? "";
  const companyId = body.companyId?.trim() ?? "";
  if (!idToken) return c.json({ message: "idToken is required." }, 400);
  if (!companyId) return c.json({ message: "companyId is required." }, 400);

  if (!isFirebaseAdminConfigured()) {
    return c.json(
      {
        message:
          "This server cannot verify Route47 accounts yet. Enter your API key once, or ask your host to set ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON.",
        firebaseConfigured: false,
      },
      503,
    );
  }

  const result = await claimOwnerDeviceKey({ companyId, idToken });
  if (!result.ok) {
    return c.json({ message: result.message, firebaseConfigured: true }, result.status as 401 | 403 | 404);
  }

  return c.json({
    message: "Owner reconnect granted.",
    apiKey: result.apiKey,
    companyId: result.companyId,
    companyName: result.companyName,
    adminId: result.adminId,
    name: result.name,
    email: result.email,
    role: "owner",
  });
});
