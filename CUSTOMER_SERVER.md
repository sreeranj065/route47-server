# Route47 Customer Server

The **customer server** is fleet-owned infrastructure that stores operational data for one company:

- Driver device auth and invites
- Live GPS heartbeats and route progress
- Admin-published route plans
- Proof of delivery uploads
- Geofences and approval workflow

The server starts with an **empty database**. Companies, drivers, and routes are created through the Admin app and driver onboarding — there is no bundled demo fleet.

## API contract

The server exposes the paths under `/route47/...` that the Route47 driver app and Admin app call. See the driver reference client:

`Route47/app/src/main/java/com/mr47/route47/data/admin/CompanyServerApiClient.kt`

Production deployments should provide:

1. Strong authentication (`ROUTE47_ADMIN_API_KEY` required; no default admin key)
2. Persistent database and file storage with backups
3. HTTPS only (driver app requirement)
4. Per-company isolation
5. Audit logging for admin actions (geofence approval, route publish)

Response header `X-Route47-Server-Mode` is `production`.
