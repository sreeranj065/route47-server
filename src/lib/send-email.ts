/**
 * Transactional email helper for PIN recovery and similar notices.
 * Configure one of:
 *   - RESEND_API_KEY + EMAIL_FROM
 *   - SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS + EMAIL_FROM
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
}

function requireFromAddress(): string {
  const from = process.env.EMAIL_FROM?.trim() || process.env.SMTP_FROM?.trim() || "";
  if (!from) {
    throw new Error("EMAIL_FROM is not configured on the company server.");
  }
  return from;
}

async function sendWithResend(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: requireFromAddress(),
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

async function sendWithSmtp(input: SendEmailInput): Promise<void> {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) throw new Error("SMTP_HOST is not configured.");

  const port = Number.parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
  const user = process.env.SMTP_USER?.trim() || "";
  const pass = process.env.SMTP_PASS?.trim() || "";
  const secure = process.env.SMTP_SECURE?.trim() === "true" || port === 465;

  // Dynamic import keeps nodemailer optional until SMTP is used.
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure,
    auth: user ? { user, pass } : undefined,
  });

  await transporter.sendMail({
    from: requireFromAddress(),
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
}

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() ||
      process.env.SMTP_HOST?.trim(),
  );
}

export async function sendTransactionalEmail(input: SendEmailInput): Promise<void> {
  const to = input.to.trim().toLowerCase();
  if (!to.includes("@")) {
    throw new Error("Invalid recipient email.");
  }

  if (process.env.RESEND_API_KEY?.trim()) {
    await sendWithResend({ ...input, to });
    return;
  }

  if (process.env.SMTP_HOST?.trim()) {
    await sendWithSmtp({ ...input, to });
    return;
  }

  throw new Error(
    "Email delivery is not configured. Set RESEND_API_KEY + EMAIL_FROM, or SMTP_HOST + EMAIL_FROM on the company server.",
  );
}
