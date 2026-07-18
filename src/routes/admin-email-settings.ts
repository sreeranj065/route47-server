import { getCompany } from "../db.js";
import { requireAdminRole, type AdminIdentity } from "../lib/admin-auth.js";
import {
  emailSettingsPublicStatus,
  readEmailSettings,
  writeEmailSettings,
} from "../lib/email-settings-store.js";
import { isEmailDeliveryConfigured } from "../lib/send-email.js";
import { companyRoutes } from "./auth.js";

function getAdmin(c: { get: (key: "admin") => AdminIdentity | undefined }) {
  return c.get("admin") ?? null;
}

companyRoutes.get("/route47/companies/:companyId/admin/settings/email-delivery", (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Not allowed." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const status = emailSettingsPublicStatus();
  const stored = readEmailSettings();
  return c.json({
    ...status,
    configured: isEmailDeliveryConfigured(),
    // Non-secret fields for the form (keys are masked).
    form: {
      emailFrom: stored.emailFrom || status.emailFrom,
      resendApiKeySet: Boolean(stored.resendApiKey) || status.hasResendKey,
      smtpHost: stored.smtpHost,
      smtpPort: stored.smtpPort || "587",
      smtpUser: stored.smtpUser,
      smtpPassSet: Boolean(stored.smtpPass),
      smtpSecure: stored.smtpSecure,
    },
  });
});

companyRoutes.put("/route47/companies/:companyId/admin/settings/email-delivery", async (c) => {
  const admin = getAdmin(c);
  if (!admin) return c.json({ message: "Admin API key required." }, 401);
  if (!requireAdminRole(admin, "owner", "admin")) {
    return c.json({ message: "Not allowed." }, 403);
  }

  const companyId = c.req.param("companyId");
  if (!getCompany(companyId)) return c.json({ message: "Company not found." }, 404);

  const body = await c
    .req
    .json<{
      emailFrom?: string;
      resendApiKey?: string;
      smtpHost?: string;
      smtpPort?: string;
      smtpUser?: string;
      smtpPass?: string;
      smtpSecure?: boolean;
      clearResendKey?: boolean;
      clearSmtpPass?: boolean;
    }>()
    .catch(() => ({} as Record<string, never>));

  const current = readEmailSettings();
  const next = writeEmailSettings({
    emailFrom: body.emailFrom ?? current.emailFrom,
    resendApiKey: body.clearResendKey
      ? ""
      : body.resendApiKey?.trim()
        ? body.resendApiKey.trim()
        : current.resendApiKey,
    smtpHost: body.smtpHost ?? current.smtpHost,
    smtpPort: body.smtpPort ?? current.smtpPort,
    smtpUser: body.smtpUser ?? current.smtpUser,
    smtpPass: body.clearSmtpPass
      ? ""
      : body.smtpPass?.trim()
        ? body.smtpPass.trim()
        : current.smtpPass,
    smtpSecure: body.smtpSecure ?? current.smtpSecure,
  });

  return c.json({
    ok: true,
    configured: isEmailDeliveryConfigured(),
    provider: next.provider,
    emailFrom: next.emailFrom,
  });
});
