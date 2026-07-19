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

## 6. Phase 2 — inject Firebase into official templates (required)

Admin “Set one up for me” opens these templates. Bake the Firebase JSON into the **template defaults** once so every new customer server gets owner-reconnect without customers touching Firebase.

### Railway template (`vast-red`)

1. Open the template project that backs [railway.com/deploy/vast-red](https://railway.com/deploy/vast-red).
2. Service → **Variables** → add `ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON` = your service-account JSON.
3. Mark it as a **template variable** / shared config so new deploys inherit it (do not expose it in the public README).
4. Ensure volume mount `/data`, `ROUTE47_ADMIN_API_KEY` generated per deploy, and healthcheck `/healthz`.
5. Redeploy a fresh test from the template and confirm `/health` includes `"owner-reconnect"`.

### Render Blueprint

1. After a Blueprint deploy, set `ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON` in the service **Environment** (Render `sync: false` in `render.yaml` means you set it in the dashboard / via API).
2. For fully automated customer deploys later, use a small Deploy Broker that calls the Render API to set this secret after Blueprint create.
3. Until the broker exists, Route47 support can set the variable once per managed customer, or rely on Railway template inheritance for the default path.

### VPS / DigitalOcean / Fly

- Preferred: run installer with the secret already exported:

  ```bash
  export ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
  curl -fsSL https://raw.githubusercontent.com/sreeranj065/route47-server/main/scripts/install.sh | sudo -E sh
  ```

- Or paste into `/opt/route47` compose env after install and `docker compose up -d`.

## 7. Phase 3 — Deploy Broker (true one-click)

Repo: [`route47-deploy-broker`](../route47-deploy-broker) (sibling of this server).

1. Deploy the broker with the **same** `ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON`.
2. Optionally set `RAILWAY_API_TOKEN` for internal tests only (customers normally paste their own Railway/Render token).
3. In Admin build env set:

   ```text
   VITE_DEPLOY_BROKER_URL=https://your-broker.example
   ```

4. Rebuild Admin (`npm run build:mobile` + `npx cap sync android`).
5. Guided deploy → Railway/Render → **One-click deploy** appears when the broker health reports `firebaseConfigured`.

Customers still rent Railway/Render themselves. The broker only calls their API with their token and injects Firebase + admin key — Route47 does not host fleet data.

## 8. Phase 4 — Admin server status pill

Customer server **1.0.9+** `/health` includes `diskUsedPercent`, `diskWarningLevelPercent`, and `lastBackupAtMillis`. Admin shows a persistent green / amber / red bar above the bottom nav (and a compact pill on Home) while connected.
