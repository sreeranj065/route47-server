# Route47 Customer Server (production)

The **customer server** is fleet-owned infrastructure that stores operational data for one company:

- Driver device auth and invites
- Live GPS heartbeats and route progress
- Admin-published route plans
- Proof of delivery uploads
- Geofences and approval workflow

## Demo server vs customer server

| | Demo server (this repo) | Customer server (production) |
|--|-------------------------|------------------------------|
| Purpose | Dev, QA, onboarding trials | Live fleet operations |
| Data | Seeded `demo-co`, reset anytime | Real company data, backups required |
| Auth | Fixed demo password & API key | Per-company secrets, rotation, RBAC |
| TLS | Usually via ngrok locally | Customer HTTPS cert / reverse proxy |
| Deployment | `npm run dev` on a laptop | Customer VM, cloud, or on-prem |
| Response header | `X-Route47-Server-Mode: demo` | `production` (or omitted) |

## API contract

Both implementations expose the same paths under `/route47/...` that the Route47 driver app and Admin app already call. See the driver reference client:

`Route47/app/src/main/java/com/mr47/route47/data/admin/CompanyServerApiClient.kt`

A production customer server should implement that contract with:

1. Strong authentication (no default passwords)
2. Persistent database and file storage with backups
3. HTTPS only
4. Per-company isolation
5. Audit logging for admin actions (geofence approval, route publish)

This demo repo is a **starting point** — fork or reimplement in your preferred stack (Node, Kotlin, Go, etc.) when building a real customer deployment.
