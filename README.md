# Route47 Company Server

The self-hosted fleet server for [Route47](https://route47.app): stores your drivers, invites, route plans, live GPS heartbeats, proof-of-delivery photos, and geofences. **You own it — Route47 never hosts or sees your fleet data.**

The Route47 Driver App and Route47 Admin App both talk to this server over the same `/route47/companies/{companyId}/...` HTTP API, no matter where you host it.

- Runtime: Node.js 24 / TypeScript / Hono / `node:sqlite`
- All persistent state (SQLite database + proof photos) lives in **one data directory** (`DATA_DIR`, `/data` in containers) so a single mounted volume survives redeploys
- Version is exposed via the health endpoints so the Admin App can show "update available"

## Deploy to Render (one click, ~$7/mo)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sreeranj065/route47-server)

The [`render.yaml`](./render.yaml) Blueprint creates one Docker web service with a 1 GB persistent disk mounted at `/data` and a randomly generated `ROUTE47_ADMIN_API_KEY`. After you sign in to Render, pick the Starter plan (persistent disks require a paid instance), and click **Apply**:

1. Wait for the first deploy to go green (the health check hits `/healthz`).
2. Your server URL is shown at the top of the service page, e.g. `https://route47-server-xxxx.onrender.com`.
3. Find your admin API key under **Environment → ROUTE47_ADMIN_API_KEY**.
4. Paste the URL + admin key into the Route47 Admin App ("Connect Your New Server").

## Deploy on Railway

Railway deploys this repo cleanly via [`railway.json`](./railway.json) (Dockerfile build + `/healthz` healthcheck):

1. Sign in at [railway.com](https://railway.com) → deploy the [published template](https://railway.com/deploy/vast-red) or **New Project → Deploy from GitHub repo** → select this repo.
2. Add a **Volume** to the service and mount it at `/data` (Railway volumes are created in the dashboard, not in `railway.json`).
3. Add `ROUTE47_ADMIN_API_KEY` = `${{secret(32)}}` (Railway generates a unique key per deployment).
4. **Do not set `PORT` manually** — Railway injects it automatically. The server listens on whatever `PORT` Railway provides.
5. Under **Settings → Networking**, generate a public domain. If you see a **Target port** field, it must match the port in the deploy log line `Listening on http://0.0.0.0:XXXX` (usually the same as Railway's injected `PORT`).
6. Your server URL is that domain, e.g. `https://route47-server-production.up.railway.app`.

## Deploy on your own VPS (Hetzner, DigitalOcean, Lightsail…)

Requires Docker. Clone the repo, edit the env values in [`docker-compose.yml`](./docker-compose.yml), then:

```bash
docker compose up -d
```

The compose file creates a named volume `route47-data` mounted at `/data`. Put an HTTPS reverse proxy in front (Caddy gives you automatic TLS in two lines) — **the driver app refuses plain-HTTP servers**:

```text
route47.your-domain.example {
    reverse_proxy 127.0.0.1:4700
}
```

Set `ROUTE47_PUBLIC_URL` to that HTTPS domain so login responses hand drivers the right URL.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4700` | HTTP port. Render/Railway inject this automatically. |
| `DATA_DIR` | `<repo>/data` locally, `/data` in Docker | Single directory for ALL persistent state: SQLite DB + proof photos. Mount your volume here. |
| `ROUTE47_DB_PATH` | `$DATA_DIR/route47.db` | Override the SQLite file path (rarely needed). |
| `ROUTE47_ADMIN_API_KEY` | *(none — required)* | Admin API key (header `X-Route47-Admin-Key`). **Must be set before using the Admin app.** |
| `ROUTE47_PUBLIC_URL` | request origin (proxy-aware) | Public HTTPS URL returned to drivers on login/invite redemption. |
| `HOST` | `0.0.0.0` | Bind address. |

## Finding your server URL afterwards

- **Render:** top of the service page — `https://<service-name>.onrender.com`
- **Railway:** Settings → Networking → Public Domain — `https://<name>.up.railway.app`
- **VPS:** the HTTPS domain you pointed at the box

Verify it's alive: open `https://<your-url>/healthz` — you should see `{"ok":true,"version":"..."}`.

## Local development (Windows/macOS/Linux)

```bash
npm install
npm run dev
```

Listens on `http://0.0.0.0:4700`; data goes to `./data/` exactly as before (no env vars needed). `npm run build` compiles to `dist/`, `npm run start:dist` runs the compiled output.

Set `ROUTE47_ADMIN_API_KEY` before connecting the Admin app. The database starts empty — create your company during Admin setup (Company ID + admin key).

The Android driver app **requires HTTPS** for fleet login. For local dev:

```bash
ngrok http 4700
set ROUTE47_PUBLIC_URL=https://xxxx.ngrok-free.app
npm run dev
```

## API contract

Implements the `/route47/...` paths the driver app and Admin app expect.

### Unauthenticated

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Infra probe: `{ ok, version }` |
| GET | `/health` | Liveness + mode + version |
| POST | `/route47/invites/redeem` | Redeem invite → device token |
| POST | `/route47/drivers/login` | Username/password → device token |

### Company (device token or admin key)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/route47/companies/{id}/health` | Company health |
| POST | `/route47/companies/{id}/devices/heartbeat` | Ingest driver GPS heartbeat |
| GET | `/route47/companies/{id}/admin/live-locations` | Latest driver locations (Admin) |
| GET | `/route47/companies/{id}/admin/live-updates` | Alias |
| GET | `/route47/companies/{id}/devices/locations` | Alias |
| GET | `/route47/companies/{id}/admin-route-plans` | Driver downloads route plans |
| POST | `/route47/companies/{id}/admin-route-plans` | Admin publishes route plans |
| GET | `/route47/companies/{id}/admin/snapshot` | Plans + approved geofences |
| POST | `/route47/companies/{id}/geofences/sync` | Driver uploads geofences (pending) |
| POST | `/route47/companies/{id}/proofs/upload` | Multipart proof upload |
| GET | `/route47/companies/{id}/proofs` | List proofs |
| GET | `/route47/companies/{id}/proofs/{proofId}/file` | Download proof file |
| POST | `/route47/companies/{id}/routes/progress` | Live stop/route events |
| POST | `/route47/companies/{id}/sync/request` | Sync stub |
| POST | `/route47/companies/{id}/reports/daily` | Report stub |

### Geofence admin (admin key)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/route47/companies/{id}/admin/geofences` | List (`?approvalStatus=pending`) |
| POST | `/route47/companies/{id}/admin/geofences` | Create admin geofence |
| PATCH | `/route47/companies/{id}/admin/geofences/{id}` | Approve/reject/edit |
| DELETE | `/route47/companies/{id}/admin/geofences/{id}` | Delete |

## Storage layout

```text
$DATA_DIR/
├── route47.db           # SQLite (companies, drivers, invites, plans, proofs index…)
└── proofs/
    └── {companyId}/     # proof-of-delivery photo files
```

Back up `$DATA_DIR` and you've backed up everything.
