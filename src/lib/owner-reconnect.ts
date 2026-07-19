import { db, getCompany } from "../db.js";
import { hashAdminKey, type AdminRow } from "./admin-auth.js";
import { rid } from "./util.js";
import { verifyFirebaseIdToken } from "./firebase-admin-app.js";

function now() {
  return Date.now();
}

export function ensureOwnerBindingSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_bindings (
      company_id TEXT PRIMARY KEY,
      firebase_uid TEXT NOT NULL UNIQUE,
      bound_email TEXT NOT NULL DEFAULT '',
      bound_at INTEGER NOT NULL
    );
  `);

  const columns = db.prepare(`PRAGMA table_info(admins)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "firebase_uid")) {
    db.exec(`ALTER TABLE admins ADD COLUMN firebase_uid TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_firebase_uid
      ON admins(firebase_uid)
      WHERE firebase_uid IS NOT NULL AND firebase_uid != '';
  `);
}

ensureOwnerBindingSchema();

export function getOwnerBinding(companyId: string) {
  return db
    .prepare(
      `SELECT company_id AS companyId, firebase_uid AS firebaseUid,
              bound_email AS boundEmail, bound_at AS boundAt
       FROM owner_bindings WHERE company_id = ?`,
    )
    .get(companyId) as
    | { companyId: string; firebaseUid: string; boundEmail: string; boundAt: number }
    | undefined;
}

export function getOwnerBindingByUid(firebaseUid: string) {
  return db
    .prepare(
      `SELECT company_id AS companyId, firebase_uid AS firebaseUid,
              bound_email AS boundEmail, bound_at AS boundAt
       FROM owner_bindings WHERE firebase_uid = ?`,
    )
    .get(firebaseUid) as
    | { companyId: string; firebaseUid: string; boundEmail: string; boundAt: number }
    | undefined;
}

/**
 * Bind the signed-in Firebase account as the company owner for reconnect.
 * Requires an already-authenticated owner session (env key or owner admin).
 */
export async function bindCompanyOwner(input: {
  companyId: string;
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

  const existing = getOwnerBinding(input.companyId);
  if (existing && existing.firebaseUid !== identity.uid) {
    return {
      ok: false,
      status: 409,
      message: "This company is already linked to a different Route47 account.",
    };
  }

  const uidTaken = getOwnerBindingByUid(identity.uid);
  if (uidTaken && uidTaken.companyId !== input.companyId) {
    return {
      ok: false,
      status: 409,
      message: "This Route47 account is already linked to another company on this server.",
    };
  }

  if (existing?.firebaseUid === identity.uid) {
    db.prepare(
      `UPDATE owner_bindings SET bound_email = ?, bound_at = ? WHERE company_id = ?`,
    ).run(identity.email, now(), input.companyId);
    return {
      ok: true,
      firebaseUid: identity.uid,
      email: identity.email,
      alreadyBound: true,
    };
  }

  db.prepare(
    `INSERT INTO owner_bindings (company_id, firebase_uid, bound_email, bound_at)
     VALUES (?, ?, ?, ?)`,
  ).run(input.companyId, identity.uid, identity.email, now());

  return {
    ok: true,
    firebaseUid: identity.uid,
    email: identity.email,
    alreadyBound: false,
  };
}

/**
 * After reinstall: Firebase ID token + companyId → fresh owner device API key.
 */
export async function claimOwnerDeviceKey(input: {
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
    }
  | { ok: false; status: number; message: string }
> {
  const identity = await verifyFirebaseIdToken(input.idToken);
  if (!identity) {
    return {
      ok: false,
      status: 401,
      message:
        "Could not verify Route47 account. Sign in again, or enter your API key manually.",
    };
  }

  const binding = getOwnerBinding(input.companyId);
  if (!binding || binding.firebaseUid !== identity.uid) {
    return {
      ok: false,
      status: 403,
      message:
        "Owner account is not linked to this company yet. Connect once with your server API key, then reconnect will work automatically.",
    };
  }

  const company = getCompany(input.companyId);
  if (!company) {
    return { ok: false, status: 404, message: "Company not found." };
  }

  const adminId = `owner-fb-${identity.uid}`;
  const apiKey = `owner_${rid("key")}`;
  const existing = db
    .prepare(`SELECT * FROM admins WHERE id = ?`)
    .get(adminId) as AdminRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE admins
       SET api_key = NULL, api_key_hash = ?, name = ?, email = ?,
           role = 'owner', status = 'active', disabled_at = NULL,
           firebase_uid = ?, redeemed_at = ?
       WHERE id = ?`,
    ).run(
      hashAdminKey(apiKey),
      identity.name,
      identity.email,
      identity.uid,
      now(),
      adminId,
    );
  } else {
    db.prepare(
      `INSERT INTO admins (
         id, company_id, name, email, role, api_key, api_key_hash,
         invite_code, invited_by, status, disabled_at, created_at, redeemed_at, firebase_uid
       ) VALUES (?, ?, ?, ?, 'owner', NULL, ?, NULL, NULL, 'active', NULL, ?, ?, ?)`,
    ).run(
      adminId,
      input.companyId,
      identity.name,
      identity.email,
      hashAdminKey(apiKey),
      now(),
      now(),
      identity.uid,
    );
  }

  return {
    ok: true,
    apiKey,
    companyId: company.id,
    companyName: company.name,
    adminId,
    name: identity.name,
    email: identity.email,
  };
}
