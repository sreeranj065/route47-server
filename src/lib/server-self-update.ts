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

export function getDeployHookUrl(): string {
  return process.env.ROUTE47_DEPLOY_HOOK_URL?.trim() || "";
}

/** Official server repo used when Railway should deploy the latest commit. */
const SERVER_GITHUB_REPO =
  process.env.ROUTE47_SERVER_GITHUB_REPO?.trim() || "sreeranj065/route47-server";
const SERVER_GITHUB_BRANCH =
  process.env.ROUTE47_SERVER_GITHUB_BRANCH?.trim() || "main";

export function getRailwayDeployConfig() {
  const token = process.env.ROUTE47_RAILWAY_API_TOKEN?.trim() || "";
  const serviceId = process.env.ROUTE47_RAILWAY_SERVICE_ID?.trim() || "";
  const environmentId = process.env.ROUTE47_RAILWAY_ENVIRONMENT_ID?.trim() || "";
  return {
    token,
    serviceId,
    environmentId,
    configured: Boolean(token && serviceId && environmentId),
  };
}

export function getSelfUpdateConfig() {
  const hostingMode = readHostingMode();
  const enabled = process.env.ROUTE47_SELF_UPDATE_ENABLED === "true";
  const composeDir = process.env.ROUTE47_COMPOSE_DIR?.trim() || "";
  const updateCommand = process.env.ROUTE47_UPDATE_COMMAND?.trim() || "";
  const dockerHost = fs.existsSync("/var/run/docker.sock");
  const deployHookUrl = getDeployHookUrl();
  const deployHookConfigured = deployHookUrl.length > 0;
  const railway = getRailwayDeployConfig();
  const supported =
    enabled &&
    (hostingMode === "docker" || hostingMode === "vps") &&
    dockerHost &&
    (updateCommand.length > 0 || composeDir.length > 0);

  return {
    hostingMode,
    enabled,
    composeDir,
    updateCommand,
    dockerHost,
    supported,
    deployHookConfigured,
    railwayConfigured: railway.configured,
    /** True when Admin can trigger an in-app update (Docker, Render hook, or Railway API). */
    inAppUpdateSupported: supported || deployHookConfigured || railway.configured,
  };
}

type PaaSTriggerResult = {
  started: boolean;
  message: string;
  status?: SelfUpdateStatus;
  mode?: "deploy_hook" | "railway_api";
};

async function fetchLatestServerCommitSha(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${SERVER_GITHUB_REPO}/commits/${encodeURIComponent(SERVER_GITHUB_BRANCH)}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { sha?: string };
    return json.sha?.trim() || null;
  } catch {
    return null;
  }
}

/** Render (and any host that exposes a deploy-hook URL). */
export async function triggerDeployHook(): Promise<PaaSTriggerResult> {
  const hookUrl = getDeployHookUrl();
  if (!hookUrl) {
    return {
      started: false,
      message:
        "No deploy hook configured. On Render set ROUTE47_DEPLOY_HOOK_URL to Settings → Deploy Hook.",
    };
  }

  const current = readSelfUpdateState();
  if (current.status === "running") {
    return { started: false, message: "An update is already in progress." };
  }

  writeSelfUpdateState({
    status: "running",
    startedAt: Date.now(),
    message: "Render deploy hook triggered — waiting for the new version…",
  });

  try {
    const response = await fetch(hookUrl, { method: "POST" });
    // Render accepts GET or POST; some hooks return 200 with empty body.
    if (!response.ok && response.status !== 201) {
      const getRes = await fetch(hookUrl, { method: "GET" });
      if (!getRes.ok) {
        const body = (await response.text().catch(() => "")).trim().slice(0, 200);
        writeSelfUpdateState({
          status: "failed",
          startedAt: current.startedAt ?? Date.now(),
          completedAt: Date.now(),
          message: `Deploy hook failed (HTTP ${response.status})${body ? `: ${body}` : ""}`,
        });
        return {
          started: false,
          message: `Deploy hook failed (HTTP ${response.status}). Check ROUTE47_DEPLOY_HOOK_URL.`,
          status: "failed",
        };
      }
    }

    writeSelfUpdateState({
      status: "success",
      startedAt: Date.now(),
      completedAt: Date.now(),
      message: "Deploy triggered on Render. Waiting for the new version to come online…",
    });

    return {
      started: true,
      message: "Render deploy started. The server will restart with the new version shortly.",
      status: "success",
      mode: "deploy_hook",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeSelfUpdateState({
      status: "failed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      message: `Deploy hook request failed: ${detail}`,
    });
    return {
      started: false,
      message: `Could not reach deploy hook: ${detail}`,
      status: "failed",
    };
  }
}

/** Railway one-tap deploy via GraphQL (account/workspace token — not project token). */
export async function triggerRailwayDeploy(): Promise<PaaSTriggerResult> {
  const railway = getRailwayDeployConfig();
  if (!railway.configured) {
    return {
      started: false,
      message:
        "Railway update not configured. Set ROUTE47_RAILWAY_API_TOKEN, ROUTE47_RAILWAY_SERVICE_ID, and ROUTE47_RAILWAY_ENVIRONMENT_ID on the server.",
    };
  }

  const current = readSelfUpdateState();
  if (current.status === "running") {
    return { started: false, message: "An update is already in progress." };
  }

  writeSelfUpdateState({
    status: "running",
    startedAt: Date.now(),
    message: "Triggering Railway deploy of the latest server commit…",
  });

  const commitSha = await fetchLatestServerCommitSha();
  const query = commitSha
    ? `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String) {
         serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
       }`
    : `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
         serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
       }`;

  try {
    const response = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${railway.token}`,
      },
      body: JSON.stringify({
        query,
        variables: {
          serviceId: railway.serviceId,
          environmentId: railway.environmentId,
          ...(commitSha ? { commitSha } : {}),
        },
      }),
    });

    const payload = (await response.json().catch(() => null)) as {
      data?: { serviceInstanceDeployV2?: string };
      errors?: Array<{ message?: string }>;
    } | null;

    if (!response.ok || payload?.errors?.length) {
      const errMsg =
        payload?.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
        `HTTP ${response.status}`;
      writeSelfUpdateState({
        status: "failed",
        startedAt: Date.now(),
        completedAt: Date.now(),
        message: `Railway deploy failed: ${errMsg}`,
      });
      return {
        started: false,
        message: `Railway deploy failed: ${errMsg}. Use an Account/Workspace token (not a Project token).`,
        status: "failed",
      };
    }

    writeSelfUpdateState({
      status: "success",
      startedAt: Date.now(),
      completedAt: Date.now(),
      message: "Railway deploy started. Waiting for the new version to come online…",
    });

    return {
      started: true,
      message: "Railway deploy started. The server will restart with the new version shortly.",
      status: "success",
      mode: "railway_api",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeSelfUpdateState({
      status: "failed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      message: `Railway API request failed: ${detail}`,
    });
    return {
      started: false,
      message: `Could not reach Railway API: ${detail}`,
      status: "failed",
    };
  }
}

/**
 * One-tap PaaS update: Render deploy hook and/or Railway GraphQL.
 * Prefer hosting-mode match, then whichever credentials are present.
 */
export async function triggerPaaSUpdate(): Promise<PaaSTriggerResult> {
  const config = getSelfUpdateConfig();
  const railway = getRailwayDeployConfig();

  if (config.hostingMode === "render" && config.deployHookConfigured) {
    return triggerDeployHook();
  }
  if (config.hostingMode === "railway" && railway.configured) {
    return triggerRailwayDeploy();
  }
  // Fallbacks when hostingMode is wrong/unset but credentials exist.
  if (config.deployHookConfigured) return triggerDeployHook();
  if (railway.configured) return triggerRailwayDeploy();

  return {
    started: false,
    message:
      "No PaaS update credentials. Render: set ROUTE47_DEPLOY_HOOK_URL. Railway: set ROUTE47_RAILWAY_API_TOKEN + ROUTE47_RAILWAY_SERVICE_ID + ROUTE47_RAILWAY_ENVIRONMENT_ID.",
  };
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
