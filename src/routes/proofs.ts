import fs from "node:fs";
import path from "node:path";
import { companyRoutes } from "./auth.js";
import { db, PROOFS_DIR } from "../db.js";

companyRoutes.post("/route47/companies/:companyId/proofs/upload", async (c) => {
  const companyId = c.get("companyId");
  const body = await c.req.parseBody({ all: true });

  const fields = body as Record<string, string | File | (string | File)[]>;

  function field(name: string): string {
    const value = fields[name];
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === "string" ? first : "";
    }
    return typeof value === "string" ? value : "";
  }

  const proofId = field("proofId") || `proof-${Date.now()}`;
  const driverId = field("driverId") || c.get("driverId");
  const driverDeviceId = field("driverDeviceId") || c.get("driverDeviceId");
  const vehicleId = field("vehicleId") || c.get("vehicleId");
  const routeRunId = field("routeRunId");
  const stopId = field("stopId");
  const proofType = field("proofType");
  const customerName = field("customerName");
  const address = field("address");
  const createdAtMillis = Number(field("createdAtMillis") || Date.now());

  const fileEntry = fields.file;
  const file = Array.isArray(fileEntry) ? fileEntry[0] : fileEntry;

  if (!(file instanceof File)) {
    return c.json({ message: "Proof file is required." }, 400);
  }

  const ext = path.extname(file.name) || ".bin";
  const storedName = `${proofId}${ext}`;
  const storedPath = path.join(PROOFS_DIR, companyId, storedName);
  fs.mkdirSync(path.dirname(storedPath), { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(storedPath, buffer);

  db.prepare(
    `INSERT INTO proofs (
      proof_id, company_id, driver_id, driver_device_id, vehicle_id, route_run_id, stop_id,
      proof_type, customer_name, address, file_name, file_path, mime_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(proof_id) DO UPDATE SET
      file_name = excluded.file_name,
      file_path = excluded.file_path,
      mime_type = excluded.mime_type`
  ).run(
    proofId,
    companyId,
    driverId,
    driverDeviceId,
    vehicleId,
    routeRunId,
    stopId,
    proofType,
    customerName,
    address,
    storedName,
    storedPath,
    file.type || "application/octet-stream",
    createdAtMillis
  );

  return c.json({
    message: "Proof uploaded to demo server.",
    proofId,
  });
});

companyRoutes.get("/route47/companies/:companyId/proofs", (c) => {
  const companyId = c.req.param("companyId");
  const routeRunId = c.req.query("routeRunId")?.trim();
  const stopId = c.req.query("stopId")?.trim();

  const rows = db
    .prepare(
      `SELECT proof_id AS proofId, company_id AS companyId, driver_id AS driverId,
              driver_device_id AS driverDeviceId, vehicle_id AS vehicleId,
              route_run_id AS routeRunId, stop_id AS stopId, proof_type AS proofType,
              customer_name AS customerName, address, file_name AS fileName,
              mime_type AS mimeType, created_at AS createdAtMillis
       FROM proofs
       WHERE company_id = ?
       ${routeRunId ? "AND route_run_id = ?" : ""}
       ${stopId ? "AND stop_id = ?" : ""}
       ORDER BY created_at DESC
       LIMIT 500`
    )
    .all(
      ...[
        companyId,
        ...(routeRunId ? [routeRunId] : []),
        ...(stopId ? [stopId] : []),
      ]
    ) as Array<Record<string, unknown>>;

  return c.json({
    message: `${rows.length} proof(s).`,
    proofs: rows,
  });
});

companyRoutes.get("/route47/companies/:companyId/proofs/:proofId/file", (c) => {
  const companyId = c.req.param("companyId");
  const proofId = c.req.param("proofId");

  const row = db
    .prepare(
      `SELECT file_path AS filePath, mime_type AS mimeType, file_name AS fileName
       FROM proofs WHERE company_id = ? AND proof_id = ?`
    )
    .get(companyId, proofId) as
    | { filePath: string; mimeType: string; fileName: string }
    | undefined;

  if (!row || !fs.existsSync(row.filePath)) {
    return c.json({ message: "Proof file not found." }, 404);
  }

  const data = fs.readFileSync(row.filePath);
  return new Response(data, {
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename=\"${row.fileName}\"`,
    },
  });
});
