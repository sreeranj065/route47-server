/**
 * Shared Firebase Admin bootstrap for push + owner reconnect (ID token verify).
 *
 * Preferred on Railway (avoids mangled multiline JSON):
 *   ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON_BASE64=<base64 of the .json file>
 *
 * Also supported:
 *   ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON=<raw json, ideally one line>
 *   GOOGLE_APPLICATION_CREDENTIALS=<path>
 */

import { Buffer } from "node:buffer";

let firebaseAdmin: typeof import("firebase-admin") | null = null;
let firebaseInitAttempted = false;
let firebaseInitError: string | null = null;
let firebaseCredentialSource: "json" | "base64" | "adc" | "none" = "none";

function stripWrappingQuotes(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/** Resolve raw service-account JSON text from env (JSON or Base64). */
export function resolveServiceAccountRaw(): {
  raw: string;
  source: "json" | "base64" | "none";
} {
  const b64 = process.env.ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (b64) {
    try {
      const decoded = Buffer.from(stripWrappingQuotes(b64), "base64").toString("utf8").trim();
      if (decoded) return { raw: decoded, source: "base64" };
      return { raw: "", source: "none" };
    } catch {
      return { raw: "", source: "none" };
    }
  }

  const json = stripWrappingQuotes(process.env.ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON ?? "");
  if (json) return { raw: json, source: "json" };
  return { raw: "", source: "none" };
}

function normalizePrivateKey(parsed: Record<string, unknown>): void {
  const key = (parsed.private_key ?? parsed.privateKey) as string | undefined;
  if (typeof key !== "string" || !key) return;

  // JSON files use "\n" escapes; some hosts turn those into real newlines already.
  // Firebase Admin needs real PEM newlines.
  let normalized = key;
  if (normalized.includes("\\n") && !normalized.includes("-----BEGIN")) {
    // rare mangled form — leave as-is and let cert() fail with a clear error
  } else if (normalized.includes("\\n")) {
    normalized = normalized.replace(/\\n/g, "\n");
  }
  parsed.private_key = normalized;
  if ("privateKey" in parsed) parsed.privateKey = normalized;
}

/** Validate + normalize the env JSON (handles common Railway paste issues). */
export function parseServiceAccountJson(raw: string):
  | { ok: true; value: import("firebase-admin").ServiceAccount }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error:
        "Firebase credentials empty. Set ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (recommended on Railway) or ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON.",
    };
  }

  let text = trimmed;
  // Sometimes the whole JSON was pasted as a JSON string value.
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const unquoted = JSON.parse(text) as unknown;
      if (typeof unquoted === "string") text = unquoted;
    } catch {
      // keep original
    }
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Service account JSON must be an object." };
    }
    if (!parsed.project_id && !parsed.projectId) {
      return { ok: false, error: "Service account JSON missing project_id." };
    }
    if (!parsed.private_key && !parsed.privateKey) {
      return { ok: false, error: "Service account JSON missing private_key." };
    }
    if (!parsed.client_email && !parsed.clientEmail) {
      return { ok: false, error: "Service account JSON missing client_email." };
    }
    normalizePrivateKey(parsed);
    return { ok: true, value: parsed as import("firebase-admin").ServiceAccount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Invalid service-account JSON (${message}). On Railway, Base64-encode the file into ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 — multiline JSON pastes often get corrupted.`,
    };
  }
}

export function getPushCredentialDiagnostics(): {
  source: "json" | "base64" | "adc" | "none";
  chars: number;
  looksLikeJson: boolean;
  projectId?: string;
  parseOk: boolean;
  parseError?: string;
} {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const { raw, source } = resolveServiceAccountRaw();
  if (!raw && path) {
    return { source: "adc", chars: 0, looksLikeJson: false, parseOk: true };
  }
  if (!raw) {
    return { source: "none", chars: 0, looksLikeJson: false, parseOk: false, parseError: "No credentials env set." };
  }
  const parsed = parseServiceAccountJson(raw);
  if (!parsed.ok) {
    return {
      source,
      chars: raw.length,
      looksLikeJson: raw.trimStart().startsWith("{"),
      parseOk: false,
      parseError: parsed.error,
    };
  }
  const projectId = String(
    (parsed.value as { project_id?: string; projectId?: string }).project_id ??
      (parsed.value as { projectId?: string }).projectId ??
      "",
  );
  return {
    source,
    chars: raw.length,
    looksLikeJson: true,
    projectId: projectId || undefined,
    parseOk: true,
  };
}

export async function getFirebaseAdminApp() {
  if (firebaseInitAttempted) return firebaseAdmin;
  firebaseInitAttempted = true;
  firebaseInitError = null;
  firebaseCredentialSource = "none";

  const { raw, source } = resolveServiceAccountRaw();
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!raw && !path) {
    firebaseInitError =
      "Missing Firebase credentials. Set ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (recommended) or ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON.";
    return null;
  }

  try {
    const admin = await import("firebase-admin");
    if (admin.apps.length === 0) {
      if (raw) {
        const parsed = parseServiceAccountJson(raw);
        if (!parsed.ok) {
          firebaseInitError = parsed.error;
          firebaseCredentialSource = source;
          console.warn("[firebase] " + parsed.error);
          return null;
        }
        admin.initializeApp({
          credential: admin.credential.cert(parsed.value),
        });
        firebaseCredentialSource = source;
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
        firebaseCredentialSource = "adc";
      }
    } else {
      firebaseCredentialSource = source !== "none" ? source : path ? "adc" : "none";
    }
    firebaseAdmin = admin;
    console.info(`[firebase] Admin SDK ready (source=${firebaseCredentialSource})`);
    return admin;
  } catch (error) {
    firebaseInitError = error instanceof Error ? error.message : String(error);
    firebaseCredentialSource = source !== "none" ? source : path ? "adc" : "none";
    console.warn("Firebase Admin SDK unavailable.", error);
    return null;
  }
}

/** True only when Firebase Admin can actually initialize (not merely env present). */
export async function isFirebaseAdminReady(): Promise<boolean> {
  const app = await getFirebaseAdminApp();
  return app != null;
}

/**
 * Sync check used by /health. Prefers a successful prior init; otherwise validates
 * that the env looks like usable credentials.
 */
export function isFirebaseAdminConfigured(): boolean {
  if (firebaseAdmin) return true;
  if (firebaseInitAttempted && !firebaseAdmin) return false;

  const { raw } = resolveServiceAccountRaw();
  if (raw) return parseServiceAccountJson(raw).ok;
  return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
}

export function getFirebaseInitError(): string | null {
  if (firebaseInitError) return firebaseInitError;
  const diag = getPushCredentialDiagnostics();
  if (!diag.parseOk) return diag.parseError ?? "Firebase credentials invalid.";
  return null;
}

export function getFirebaseCredentialSource(): typeof firebaseCredentialSource {
  return firebaseCredentialSource;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  name: string;
} | null> {
  const token = idToken.trim();
  if (!token || token.split(".").length !== 3) return null;

  const admin = await getFirebaseAdminApp();
  if (!admin) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: (decoded.email ?? "").trim(),
      name: (decoded.name ?? decoded.email ?? "Owner").trim() || "Owner",
    };
  } catch (error) {
    console.warn("Firebase ID token verification failed.", error);
    return null;
  }
}
