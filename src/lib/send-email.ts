/**
 * Transactional email helper for PIN recovery and similar notices.
 * Configure via Admin App (stored in DATA_DIR) or env:
 *   - RESEND_API_KEY + EMAIL_FROM
 *   - SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS + EMAIL_FROM
 */

import { readEmailSettings } from "./email-settings-store.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
}

function resolvedConfig() {
  const stored = readEmailSettings();
  const emailFrom =
    stored.emailFrom ||
    process.env.EMAIL_FROM?.trim() ||
    process.env.SMTP_FROM?.trim() ||
    "";
  const resendApiKey = stored.resendApiKey || process.env.RESEND_API_KEY?.trim() || "";
  const smtpHost = stored.smtpHost || process.env.SMTP_HOST?.trim() || "";
  const smtpPort = stored.smtpPort || process.env.SMTP_PORT?.trim() || "587";
  const smtpUser = stored.smtpUser || process.env.SMTP_USER?.trim() || "";
  const smtpPass = stored.smtpPass || process.env.SMTP_PASS?.trim() || "";
  const smtpSecure =
    stored.smtpSecure ||
    process.env.SMTP_SECURE?.trim() === "true" ||
    smtpPort === "465";
  return { emailFrom, resendApiKey, smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure };
}

function requireFromAddress(from: string): string {
  if (!from) {
    throw new Error("EMAIL_FROM is not configured on the company server.");
  }
  return from;
}

async function sendWithResend(input: SendEmailInput, apiKey: string, from: string): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: requireFromAddress(from),
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Resend email failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
}

async function sendWithSmtp(
  input: SendEmailInput,
  cfg: ReturnType<typeof resolvedConfig>,
): Promise<void> {
  const port = Number.parseInt(cfg.smtpPort || "587", 10);
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: Number.isFinite(port) ? port : 587,
    secure: cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
  });

  await transporter.sendMail({
    from: requireFromAddress(cfg.emailFrom),
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
}

export function isEmailDeliveryConfigured(): boolean {
  const cfg = resolvedConfig();
  return Boolean(cfg.emailFrom && (cfg.resendApiKey || cfg.smtpHost));
}

export async function sendTransactionalEmail(input: SendEmailInput): Promise<void> {
  const to = input.to.trim().toLowerCase();
  if (!to.includes("@")) {
    throw new Error("Invalid recipient email.");
  }

  const cfg = resolvedConfig();
  if (cfg.resendApiKey) {
    await sendWithResend({ ...input, to }, cfg.resendApiKey, cfg.emailFrom);
    return;
  }

  if (cfg.smtpHost) {
    await sendWithSmtp({ ...input, to }, cfg);
    return;
  }

  throw new Error(
    "Email delivery is not configured. In Admin → Server → Email delivery, set Resend or SMTP.",
  );
}
