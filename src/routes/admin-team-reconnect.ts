import { Hono } from "hono";
import { companyRoutes } from "./auth.js";
import { hasAdminAccess } from "../lib/route-admin.js";
import { bindAdminAccount, claimAdminDeviceKey } from "../lib/admin-reconnect.js";
import { isFirebaseAdminConfigured } from "../lib/firebase-admin-app.js";

/** Any active admin can link their Route47 sign-in for reconnect. */
companyRoutes.post("/route47/companies/:companyId/admin/team/me/bind", async (c) => {
  if (!hasAdminAccess(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const admin = c.get("admin");
  if (!admin?.id) {
    return c.json({ message: "Admin session required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const body = await c.req.json<{ idToken?: string }>().catch(() => ({} as { idToken?: string }));
  const idToken = body.idToken?.trim() ?? "";
  if (!idToken) {
    return c.json({ message: "idToken is required." }, 400);
  }

  const result = await bindAdminAccount({
    companyId,
    adminId: admin.id,
    idToken,
  });
  if (!result.ok) {
    return c.json({ message: result.message }, result.status as 401 | 404 | 409);
  }

  return c.json({
    message: result.alreadyBound
      ? "Route47 account already linked for reconnect."
      : "Route47 account linked for reconnect.",
    firebaseUid: result.firebaseUid,
    email: result.email,
    alreadyBound: result.alreadyBound,
    firebaseConfigured: isFirebaseAdminConfigured(),
  });
});

/** Unauthenticated claim — Firebase ID token proves invitee after bind. */
export const teamClaimRoutes = new Hono();

teamClaimRoutes.post("/route47/admin/team/claim", async (c) => {
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
          "This server cannot verify Route47 accounts yet. Enter your invite code once, or ask your host to set ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON.",
        firebaseConfigured: false,
      },
      503,
    );
  }

  const result = await claimAdminDeviceKey({ companyId, idToken });
  if (!result.ok) {
    return c.json(
      { message: result.message, firebaseConfigured: true },
      result.status as 401 | 403 | 404,
    );
  }

  return c.json({
    message: "Teammate reconnect granted.",
    apiKey: result.apiKey,
    companyId: result.companyId,
    companyName: result.companyName,
    adminId: result.adminId,
    name: result.name,
    email: result.email,
    role: result.role,
    branchIds: result.branchIds,
    defaultBranchId: result.defaultBranchId,
  });
});
