/**
 * VPS/Docker self-update — pulls the latest official image and recreates the
 * compose stack. Only active when ROUTE47_SELF_UPDATE_ENABLED=true and the
 * host mounts the Docker socket + compose directory (see scripts/install.sh).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

export type ServerHostingMode = "docker" | "vps" | "railway" | "render" | "development";

export type SelfUpdateStatus = "idle" | "running" | "success" | "failed";

export interface SelfUpdateState {
  status: SelfUpdateStatus;
  startedAt?: number;
  completedAt?: number;
  message?: string;
}

const STATUS_FILE = path.join(DATA_DIR, ".server-update-status.json");

function readHostingMode(): ServerHostingMode {
  const raw = process.env.ROUTE47_HOSTING_MODE?.trim().toLowerCase();
  if (raw === "docker" || raw === "vps" || raw === "railway" || raw === "render") return raw;
  return "development";
}

export function getSelfUpdateConfig() {
  const hostingMode = readHostingMode();
  const enabled = process.env.ROUTE47_SELF_UPDATE_ENABLED === "true";
  const composeDir = process.env.ROUTE47_COMPOSE_DIR?.trim() || "";
  const updateCommand = process.env.ROUTE47_UPDATE_COMMAND?.trim() || "";
  const dockerHost = fs.existsSync("/var/run/docker.sock");
  const supported =
    enabled &&
    (hostingMode === "docker" || hostingMode === "vps") &&
    dockerHost &&
    (updateCommand.length > 0 || composeDir.length > 0);

  return { hostingMode, enabled, composeDir, updateCommand, dockerHost, supported };
}

export function readSelfUpdateState(): SelfUpdateState {
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    return JSON.parse(raw) as SelfUpdateState;
  } catch {
    return { status: "idle" };
  }
}

function writeSelfUpdateState(state: SelfUpdateState) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(state));
}

function buildUpdateShellCommand(): string | null {
  const { updateCommand, composeDir } = getSelfUpdateConfig();
  if (updateCommand) return updateCommand;
  if (!composeDir) return null;
  return `cd "${composeDir}" && docker compose pull && docker compose up -d`;
}

export function triggerSelfUpdate(): { started: boolean; message: string } {
  const config = getSelfUpdateConfig();
  if (!config.supported) {
    return {
      started: false,
      message: "Self-update is not available on this hosting (requires Docker/VPS with socket access).",
    };
  }

  const current = readSelfUpdateState();
  if (current.status === "running") {
    return { started: false, message: "An update is already in progress." };
  }

  const shellCommand = buildUpdateShellCommand();
  if (!shellCommand) {
    return { started: false, message: "Update command is not configured on this server." };
  }

  writeSelfUpdateState({
    status: "running",
    startedAt: Date.now(),
    message: "Pulling the latest Route47 server image…",
  });

  const child = spawn("sh", ["-c", shellCommand], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  child.on("close", (code) => {
    if (code === 0) {
      writeSelfUpdateState({
        status: "success",
        startedAt: current.startedAt ?? Date.now(),
        completedAt: Date.now(),
        message: "Update finished. The server is restarting with the new version.",
      });
    } else {
      writeSelfUpdateState({
        status: "failed",
        startedAt: current.startedAt ?? Date.now(),
        completedAt: Date.now(),
        message: output.trim().slice(-500) || `Update command exited with code ${code ?? "unknown"}.`,
      });
    }
  });

  child.unref();
  return {
    started: true,
    message: "Update started. The server will restart shortly — refresh the connection in a minute.",
  };
}
