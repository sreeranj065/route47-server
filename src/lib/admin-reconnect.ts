/**
 * Invitee (non-owner admin) reconnect — bind Firebase UID to the admin row,
 * then claim a fresh team API key after reinstall.
 */
import { db, getCompany } from "../db.js";
import {
  getAdminBranchIds,
  getAdminDefaultBranchId,
  hashAdminKey,
  type AdminRow,
} from "./admin-auth.js";
import { verifyFirebaseIdToken } from "./firebase-admin-app.js";
import { rid } from "./util.js";
import { ensureOwnerBindingSchema, getOwnerBindingByUid } from "./owner-reconnect.js";

function now() {
  return Date.now();
}

ensureOwnerBindingSchema();

function getAdminByFirebaseUid(firebaseUid: string) {
  return db
    .prepare(
      `SELECT * FROM admins
       WHERE firebase_uid = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(firebaseUid) as AdminRow | undefined;
}

/**
 * Link the signed-in Firebase account to this admin row for reconnect.
 * Call after invite redeem or any successful team-key session.
 */
export async function bindAdminAccount(input: {
  companyId: string;
  adminId: string;
  idToken: string;
}): Promise<
  | { ok: true; firebaseUid: string; email: string; alreadyBound: boolean }
  | { ok: false; status: number; message: string }
> {
  const company = getCompany(input.companyId);
  if (!company) {
    return { ok: false, status: 404, message: "Company not found." };
  }

  const identity = await verifyFirebaseIdToken(input.idToken);
  if (!identity) {
    return {
      ok: false,
      status: 401,
      message:
        "Could not verify Route47 account. Ensure the server has Firebase Admin credentials for the Admin app project.",
    };
  }

  const admin = db
    .prepare(`SELECT * FROM admins WHERE company_id = ? AND id = ?`)
    .get(input.companyId, input.adminId) as AdminRow | undefined;

  if (!admin || admin.status !== "active") {
    return { ok: false, status: 404, message: "Admin account not found or not active." };
  }

  // Owner env-key binding uses owner_bindings — don't steal that UID onto a team row.
  const ownerBinding = getOwnerBindingByUid(identity.uid);
  if (ownerBinding && ownerBinding.companyId === input.companyId && admin.role !== "owner") {
    return {
      ok: false,
      status: 409,
      message: "This Route47 account is already linked as the company owner.",
    };
  }

  const taken = getAdminByFirebaseUid(identity.uid);
  if (taken && taken.id !== admin.id) {
    return {
      ok: false,
      status: 409,
      message: "This Route47 account is already linked to another admin on this server.",
    };
  }

  if (admin.firebase_uid && admin.firebase_uid !== identity.uid) {
    return {
      ok: false,
      status: 409,
      message: "This teammate is already linked to a different Route47 account.",
    };
  }

  if (admin.firebase_uid === identity.uid) {
    db.prepare(`UPDATE admins SET email = COALESCE(NULLIF(?, ''), email) WHERE id = ?`).run(
      identity.email,
      admin.id,
    );
    return {
      ok: true,
      firebaseUid: identity.uid,
      email: identity.email,
      alreadyBound: true,
    };
  }

  db.prepare(`UPDATE admins SET firebase_uid = ?, email = COALESCE(NULLIF(?, ''), email) WHERE id = ?`).run(
    identity.uid,
    identity.email,
    admin.id,
  );

  return {
    ok: true,
    firebaseUid: identity.uid,
    email: identity.email,
    alreadyBound: false,
  };
}

/** After reinstall: Firebase ID token + companyId → fresh team API key. */
export async function claimAdminDeviceKey(input: {
  companyId: string;
  idToken: string;
}): Promise<
  | {
      ok: true;
      apiKey: string;
      companyId: string;
      companyName: string;
      adminId: string;
      name: string;
      email: string;
      role: string;
      branchIds: string[];
      defaultBranchId: string | null;
    }
  | { ok: false; status: number; message: string }
> {
  const identity = await verifyFirebaseIdToken(input.idToken);
  if (!identity) {
    return {
      ok: false,
      status: 401,
      message:
        "Could not verify Route47 account. Sign in again, or enter your invite / API key manually.",
    };
  }

  const company = getCompany(input.companyId);
  if (!company) {
    return { ok: false, status: 404, message: "Company not found." };
  }

  const admin = db
    .prepare(
      `SELECT * FROM admins
       WHERE company_id = ? AND firebase_uid = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(input.companyId, identity.uid) as AdminRow | undefined;

  if (!admin) {
    return {
      ok: false,
      status: 403,
      message:
        "Teammate account is not linked yet. Join once with your invite code, then reconnect will work automatically.",
    };
  }

  if (admin.status === "disabled") {
    return { ok: false, status: 403, message: "This admin account has been disabled." };
  }

  const apiKey = `team_${rid("key")}`;
  db.prepare(
    `UPDATE admins
     SET api_key = NULL, api_key_hash = ?, name = COALESCE(NULLIF(?, ''), name),
         email = COALESCE(NULLIF(?, ''), email), disabled_at = NULL, redeemed_at = ?
     WHERE id = ?`,
  ).run(hashAdminKey(apiKey), identity.name, identity.email, now(), admin.id);

  return {
    ok: true,
    apiKey,
    companyId: company.id,
    companyName: company.name,
    adminId: admin.id,
    name: admin.name || identity.name,
    email: identity.email || admin.email,
    role: admin.role,
    branchIds: getAdminBranchIds(company.id, admin.id),
    defaultBranchId: getAdminDefaultBranchId(company.id, admin.id),
  };
}
