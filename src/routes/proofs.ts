import fs from "node:fs";
import path from "node:path";
import { DEMO_SERVER } from "../config.js";
import { companyRoutes } from "./auth.js";
import { db, PROOFS_DIR } from "../db.js";
import { buildProofFolderName, buildStoredProofPath } from "../proof-storage.js";

function readAdminKey(c: { req: { header: (name: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return c.req.header("X-Route47-Admin-Key")?.trim() ?? bearer;
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  const expected = process.env.ROUTE47_ADMIN_API_KEY ?? DEMO_SERVER.defaultAdminApiKey;
  const provided = readAdminKey(c);
  return !!provided && provided === expected;
}

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

  const { storedPath, storedName, relativePath } = buildStoredProofPath({
    companyId,
    proofId,
    proofType,
    routeRunId,
    originalFileName: file.name || `${proofId}.bin`,
  });

  fs.mkdirSync(path.dirname(storedPath), { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(storedPath, buffer);

  db.prepare(
    `INSERT INTO proofs (
      proof_id, company_id, driver_id, driver_device_id, vehicle_id, route_run_id, stop_id,
      proof_type, customer_name, address, file_name, file_path, mime_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(proof_id) DO UPDATE SET
      driver_id = excluded.driver_id,
      route_run_id = excluded.route_run_id,
      stop_id = excluded.stop_id,
      proof_type = excluded.proof_type,
      customer_name = excluded.customer_name,
      address = excluded.address,
      file_name = excluded.file_name,
      file_path = excluded.file_path,
      mime_type = excluded.mime_type,
      created_at = excluded.created_at`
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
    message: "Proof uploaded.",
    proofId,
    storageFolder: buildProofFolderName(proofType),
    relativePath,
  });
});

companyRoutes.get("/route47/companies/:companyId/proofs", (c) => {
  const companyId = c.req.param("companyId");
  const routeRunId = c.req.query("routeRunId")?.trim();
  const stopId = c.req.query("stopId")?.trim();
  const driverId = c.req.query("driverId")?.trim();
  const proofType = c.req.query("proofType")?.trim();
  const fromMillis = Number(c.req.query("fromMillis") ?? "");
  const toMillis = Number(c.req.query("toMillis") ?? "");

  const conditions = ["company_id = ?"];
  const params: Array<string | number> = [companyId];

  if (routeRunId) {
    conditions.push("route_run_id = ?");
    params.push(routeRunId);
  }
  if (stopId) {
    conditions.push("stop_id = ?");
    params.push(stopId);
  }
  if (driverId) {
    conditions.push("driver_id = ?");
    params.push(driverId);
  }
  if (proofType) {
    conditions.push("LOWER(proof_type) LIKE ?");
    params.push(`%${proofType.toLowerCase()}%`);
  }
  if (Number.isFinite(fromMillis) && fromMillis > 0) {
    conditions.push("created_at >= ?");
    params.push(fromMillis);
  }
  if (Number.isFinite(toMillis) && toMillis > 0) {
    conditions.push("created_at <= ?");
    params.push(toMillis);
  }

  const rows = db
    .prepare(
      `SELECT proof_id AS proofId, company_id AS companyId, driver_id AS driverId,
              driver_device_id AS driverDeviceId, vehicle_id AS vehicleId,
              route_run_id AS routeRunId, stop_id AS stopId, proof_type AS proofType,
              customer_name AS customerName, address, file_name AS fileName,
              file_path AS filePath, mime_type AS mimeType, created_at AS createdAtMillis
       FROM proofs
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 500`
    )
    .all(...params) as Array<Record<string, unknown>>;

  const proofs = rows.map((row) => ({
    ...row,
    storageFolder: buildProofFolderName(String(row.proofType ?? "")),
  }));

  return c.json({
    message: `${proofs.length} proof(s).`,
    proofs,
  });
});

type ProofRow = {
  proof_id: string;
  company_id: string;
  driver_id: string;
  route_run_id: string;
  stop_id: string;
  proof_type: string;
  customer_name: string;
  address: string;
  file_name: string;
  file_path: string;
};

function loadProofRow(companyId: string, proofId: string): ProofRow | undefined {
  return db
    .prepare(
      `SELECT proof_id, company_id, driver_id, route_run_id, stop_id, proof_type,
              customer_name, address, file_name, file_path
       FROM proofs WHERE company_id = ? AND proof_id = ?`,
    )
    .get(companyId, proofId) as ProofRow | undefined;
}

function relocateProofFile(row: ProofRow, next: {
  routeRunId: string;
  proofType: string;
  fileName: string;
}): { storedPath: string; storedName: string } {
  const { storedPath, storedName } = buildStoredProofPath({
    companyId: row.company_id,
    proofId: row.proof_id,
    proofType: next.proofType,
    routeRunId: next.routeRunId,
    originalFileName: next.fileName,
  });

  if (storedPath !== row.file_path && row.file_path && fs.existsSync(row.file_path)) {
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    try {
      fs.renameSync(row.file_path, storedPath);
    } catch {
      fs.copyFileSync(row.file_path, storedPath);
      try {
        fs.unlinkSync(row.file_path);
      } catch {
        // Best-effort cleanup of the old flat path.
      }
    }
  }

  return { storedPath, storedName };
}

companyRoutes.patch("/route47/companies/:companyId/proofs/:proofId", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const proofId = c.req.param("proofId");
  const body = await c.req.json<{
    fileName?: string;
    customerName?: string;
    address?: string;
    driverId?: string;
    routeRunId?: string;
    stopId?: string;
    proofType?: string;
  }>();

  const row = loadProofRow(companyId, proofId);
  if (!row) {
    return c.json({ message: "Proof not found." }, 404);
  }

  const nextRouteRunId = body.routeRunId ?? row.route_run_id;
  const nextProofType = body.proofType ?? row.proof_type;
  const nextFileName = body.fileName ?? row.file_name;
  const { storedPath, storedName } = relocateProofFile(row, {
    routeRunId: nextRouteRunId,
    proofType: nextProofType,
    fileName: nextFileName,
  });

  db.prepare(
    `UPDATE proofs SET
      driver_id = ?,
      route_run_id = ?,
      stop_id = ?,
      proof_type = ?,
      customer_name = ?,
      address = ?,
      file_name = ?,
      file_path = ?
     WHERE company_id = ? AND proof_id = ?`,
  ).run(
    body.driverId ?? row.driver_id,
    nextRouteRunId,
    body.stopId ?? row.stop_id,
    nextProofType,
    body.customerName ?? row.customer_name,
    body.address ?? row.address,
    storedName,
    storedPath,
    companyId,
    proofId,
  );

  return c.json({
    message: "Proof updated.",
    proofId,
    storageFolder: buildProofFolderName(nextProofType),
  });
});

companyRoutes.delete("/route47/companies/:companyId/proofs/:proofId", (c) => {
  if (!requireAdmin(c)) {
    return c.json({ message: "Admin API key required." }, 401);
  }

  const companyId = c.req.param("companyId");
  const proofId = c.req.param("proofId");

  const row = db
    .prepare(
      `SELECT file_path AS filePath
       FROM proofs WHERE company_id = ? AND proof_id = ?`
    )
    .get(companyId, proofId) as { filePath: string } | undefined;

  if (!row) {
    return c.json({ message: "Proof not found." }, 404);
  }

  if (row.filePath && fs.existsSync(row.filePath)) {
    try {
      fs.unlinkSync(row.filePath);
    } catch {
      // Best-effort file cleanup.
    }
  }

  db.prepare(`DELETE FROM proofs WHERE company_id = ? AND proof_id = ?`).run(
    companyId,
    proofId
  );

  return c.json({ message: "Proof deleted.", proofId });
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
