# Route47 vendor setup (you — not customers)

Customers never open Firebase. You do this once, then inject the same secret into every company server you provision (test Railway today; guided deploy in Phase 2).

## 1. Create the Firebase service account

1. Open [Firebase Console](https://console.firebase.google.com/) → project **`route47-admin`** (same project as the Admin app).
2. Gear → **Project settings** → **Service accounts**.
3. Click **Generate new private key** → confirm → download the JSON file.
4. Store it in a password manager / secrets vault. **Never commit it to GitHub.**

## 2. Put it on your test Railway server

1. Open your Route47 test service on [Railway](https://railway.com).
2. **Variables** → **New Variable**.
3. Name (exact):

   ```text
   ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON
   ```

4. Value: paste the **entire** JSON file contents (starts with `{`, ends with `}`).
5. Save and wait for redeploy.
6. Confirm: open `https://<your-server>/health` — `version` should be **1.0.8+** and `adminFeatures` should include `"owner-reconnect"`.

## 3. Link your owner account (one-time)

1. Install the latest Admin app.
2. Sign in with your Route47 account.
3. Connect to the test server with URL + Company ID + `ROUTE47_ADMIN_API_KEY` → **Test Connection** → finish.
4. That call binds your Firebase UID for reconnect.
5. Reinstall / clear app data → sign in again → **Reconnect** should work without pasting the API key.

## 4. What customers do (never this file)

They only copy **Server URL**, **Company ID**, and **`ROUTE47_ADMIN_API_KEY`** from their host dashboard. The Admin app guides them.

Firebase / service accounts stay vendor-only until Phase 2 injects this variable automatically during “Set one up for me”.

## 5. Shipping templates (maintainers)

- Keep `package.json` `version` ≥ `1.0.8`.
- Public templates document `ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON` as **optional for customers / required for vendor-managed deploys**.
- Do **not** put the real JSON in `render.yaml`, `railway.json`, or the public installer.
- Phase 2: Deploy Broker sets this env via Railway/Render APIs when creating a customer instance.
