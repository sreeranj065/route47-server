# AGENTS.md

## Cursor Cloud specific instructions

Route47 Company Server: a single self-hosted TypeScript/Hono backend (no monorepo,
no separate DB/cache/queue). SQLite is embedded via `node:sqlite` and all state
(DB + proof photos + message attachments) lives under `DATA_DIR` (defaults to
`./data`, gitignored). Standard commands live in `README.md` and `package.json`.

### Node version (important, non-obvious)
- The app requires **Node.js >= 23.4** (uses `node:sqlite` `DatabaseSync`); the repo
  targets **Node 24**. On older Node the server crashes at import.
- The base image ships `/exec-daemon/node` (Node 22) which **shadows nvm on `PATH`**.
  Node 24 is installed via nvm and `~/.bashrc` has been configured to select it, so
  **login shells (`bash -l`) get Node 24 automatically**. If you run a non-login shell
  and see Node 22, prepend nvm to PATH, e.g.
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` (or `nvm use 24`).

### Run / build / typecheck
- Dev server (hot reload): `ROUTE47_ADMIN_API_KEY=<key> npm run dev` — listens on
  `http://0.0.0.0:4700`. Set `ROUTE47_ADMIN_API_KEY` or all admin endpoints reject
  requests (the server still boots and driver endpoints work).
- Build / typecheck: `npm run build` (runs `tsc`, strict). **There is no separate
  lint or test script** — `tsc` is the compile/typecheck gate.
- Compiled run: `npm run start:dist` (after build).

### Testing the API end to end (no GUI)
This is a headless HTTP API. A minimal core-functionality smoke test:
1. Create company: `PATCH /route47/companies/{id}/admin/company` (header
   `X-Route47-Admin-Key`).
2. Create invite: `POST /route47/companies/{id}/admin/invites` (admin key).
3. Redeem: `POST /route47/invites/redeem` `{inviteCode, companyId}` → `deviceAuthToken`.
4. Heartbeat: `POST /route47/companies/{id}/devices/heartbeat` with
   `Authorization: Bearer <deviceAuthToken>` and `{latitude, longitude, ...}`.
5. Read back: `GET /route47/companies/{id}/admin/live-locations` (admin key).

### Optional integrations (degrade gracefully if unset)
- FCM push: `ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`.
- Business search: `ROUTE47_SERPER_API_KEY` (falls back to public scraping/Nominatim).
- The Android driver app requires HTTPS; for real-device testing front the server with
  an HTTPS tunnel/proxy (see `README.md`).
