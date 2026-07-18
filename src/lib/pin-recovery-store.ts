import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

export interface PinRecoveryRecord {
  email: string;
  hash: string;
  salt: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MIN_RESEND_MS = 60_000;
const OTP_MAX_ATTEMPTS = 5;

function storePath(companyId: string): string {
  return path.join(DATA_DIR, "pin-recovery", `${companyId}.json`);
}

function readStore(companyId: string): Record<string, PinRecoveryRecord> {
  try {
    const raw = fs.readFileSync(storePath(companyId), "utf8");
    return JSON.parse(raw) as Record<string, PinRecoveryRecord>;
  } catch {
    return {};
  }
}

function writeStore(companyId: string, data: Record<string, PinRecoveryRecord>) {
  const file = storePath(companyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
}

function hashCode(salt: string, code: string): string {
  return crypto.createHash("sha256").update(`${salt}:${code}`, "utf8").digest("hex");
}

export function createPinRecoveryOtp(
  companyId: string,
  email: string,
): { code: string; maskedEmail: string } | { error: string } {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    return { error: "Enter a valid recovery email." };
  }

  const store = readStore(companyId);
  const existing = store[normalized];
  const now = Date.now();
  if (existing && now - existing.lastSentAt < OTP_MIN_RESEND_MS) {
    const waitSec = Math.ceil((OTP_MIN_RESEND_MS - (now - existing.lastSentAt)) / 1000);
    return { error: `Wait ${waitSec}s before requesting another code.` };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const salt = crypto.randomUUID();
  store[normalized] = {
    email: normalized,
    hash: hashCode(salt, code),
    salt,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  };
  writeStore(companyId, store);

  const [local, domain] = normalized.split("@");
  const maskedLocal =
    local.length <= 2 ? `${local[0] ?? "*"}*` : `${local.slice(0, 2)}${"*".repeat(Math.min(local.length - 2, 4))}`;
  return { code, maskedEmail: `${maskedLocal}@${domain}` };
}

export function verifyPinRecoveryOtp(
  companyId: string,
  email: string,
  code: string,
): { ok: true } | { ok: false; error: string } {
  const normalized = email.trim().toLowerCase();
  const store = readStore(companyId);
  const state = store[normalized];
  if (!state) return { ok: false, error: "No recovery code requested." };
  if (Date.now() > state.expiresAt) {
    delete store[normalized];
    writeStore(companyId, store);
    return { ok: false, error: "Recovery code expired. Request a new one." };
  }
  if (state.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: "Too many attempts. Request a new code." };
  }

  const candidate = hashCode(state.salt, code.trim());
  if (candidate !== state.hash) {
    store[normalized] = { ...state, attempts: state.attempts + 1 };
    writeStore(companyId, store);
    return { ok: false, error: "Incorrect recovery code." };
  }

  delete store[normalized];
  writeStore(companyId, store);
  return { ok: true };
}
