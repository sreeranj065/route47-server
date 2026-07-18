import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

export type EmailProvider = "resend" | "smtp" | "none";

export interface EmailDeliverySettings {
  provider: EmailProvider;
  emailFrom: string;
  resendApiKey: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
}

const FILE = path.join(DATA_DIR, ".email-delivery.json");

const EMPTY: EmailDeliverySettings = {
  provider: "none",
  emailFrom: "",
  resendApiKey: "",
  smtpHost: "",
  smtpPort: "587",
  smtpUser: "",
  smtpPass: "",
  smtpSecure: false,
};

export function readEmailSettings(): EmailDeliverySettings {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<EmailDeliverySettings>;
    return {
      ...EMPTY,
      ...raw,
      provider: raw.provider === "resend" || raw.provider === "smtp" ? raw.provider : "none",
      smtpSecure: Boolean(raw.smtpSecure),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function writeEmailSettings(patch: Partial<EmailDeliverySettings>): EmailDeliverySettings {
  const current = readEmailSettings();
  const next: EmailDeliverySettings = {
    ...current,
    ...patch,
    emailFrom: String(patch.emailFrom ?? current.emailFrom).trim(),
    resendApiKey: String(patch.resendApiKey ?? current.resendApiKey).trim(),
    smtpHost: String(patch.smtpHost ?? current.smtpHost).trim(),
    smtpPort: String(patch.smtpPort ?? current.smtpPort || "587").trim(),
    smtpUser: String(patch.smtpUser ?? current.smtpUser).trim(),
    smtpPass: String(patch.smtpPass ?? current.smtpPass).trim(),
    smtpSecure: Boolean(patch.smtpSecure ?? current.smtpSecure),
  };

  if (next.resendApiKey) next.provider = "resend";
  else if (next.smtpHost) next.provider = "smtp";
  else next.provider = "none";

  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Public status — never returns secrets. */
export function emailSettingsPublicStatus(): {
  configured: boolean;
  provider: EmailProvider;
  emailFrom: string;
  hasResendKey: boolean;
  hasSmtp: boolean;
} {
  const s = readEmailSettings();
  const envResend = Boolean(process.env.RESEND_API_KEY?.trim());
  const envSmtp = Boolean(process.env.SMTP_HOST?.trim());
  const envFrom = (process.env.EMAIL_FROM || process.env.SMTP_FROM || "").trim();
  const configured =
    Boolean(s.emailFrom && (s.resendApiKey || s.smtpHost)) ||
    Boolean(envFrom && (envResend || envSmtp));
  const provider: EmailProvider = s.provider !== "none"
    ? s.provider
    : envResend
      ? "resend"
      : envSmtp
        ? "smtp"
        : "none";
  return {
    configured,
    provider,
    emailFrom: s.emailFrom || envFrom,
    hasResendKey: Boolean(s.resendApiKey) || envResend,
    hasSmtp: Boolean(s.smtpHost) || envSmtp,
  };
}
