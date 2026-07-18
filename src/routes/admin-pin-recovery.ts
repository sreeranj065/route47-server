import { getCompany } from "../db.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import { createPinRecoveryOtp, verifyPinRecoveryOtp } from "../lib/pin-recovery-store.js";
import { isEmailDeliveryConfigured, sendTransactionalEmail } from "../lib/send-email.js";
import { companyRoutes } from "./auth.js";

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

companyRoutes.post("/route47/companies/:companyId/admin/security/pin-recovery/send", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin", "dispatcher", "viewer")) {
    return c.json({ message: "Not allowed." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  if (!isEmailDeliveryConfigured()) {
    return c.json(
      {
        message:
          "Email delivery is not configured on this company server. Set RESEND_API_KEY + EMAIL_FROM, or SMTP_HOST + EMAIL_FROM.",
      },
      503,
    );
  }

  const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));
  const email = String(body.email ?? "").trim().toLowerCase();
  const created = createPinRecoveryOtp(companyId, email);
  if ("error" in created) {
    return c.json({ message: created.error }, 400);
  }

  try {
    await sendTransactionalEmail({
      to: email,
      subject: "Route47 Admin PIN recovery code",
      text:
        `Your Route47 Admin recovery code is ${created.code}.\n\n` +
        `It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    });
  } catch (error) {
    console.error("PIN recovery email failed:", error);
    return c.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "Could not send recovery email. Check server email configuration.",
      },
      502,
    );
  }

  // Never return the code to the client.
  return c.json({
    ok: true,
    maskedEmail: created.maskedEmail,
    expiresInSeconds: 600,
  });
});

companyRoutes.post("/route47/companies/:companyId/admin/security/pin-recovery/verify", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c.req
    .json<{ email?: string; code?: string }>()
    .catch(() => ({} as { email?: string; code?: string }));
  const email = String(body.email ?? "").trim().toLowerCase();
  const code = String(body.code ?? "").trim();
  if (!email || !code) {
    return c.json({ message: "Email and code are required." }, 400);
  }

  const verified = verifyPinRecoveryOtp(companyId, email, code);
  if (!verified.ok) {
    return c.json({ message: verified.error }, 400);
  }

  return c.json({ ok: true });
});
