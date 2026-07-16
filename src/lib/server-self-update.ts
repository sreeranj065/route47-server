/**
 * VPS/Docker self-update — pulls the latest official image and recreates the
 * compose stack. Only active when ROUTE47_SELF_UPDATE_ENABLED=true and the
 * host mounts the Docker socket + compose directory (see scripts/install.sh).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";
import { readStoredUpdateCredentials } from "./update-credentials-store.js";

export type ServerHostingMode = "docker" | "vps" | "railway" | "render" | "development";

export type SelfUpdateStatus = "idle" | "running" | "success" | "failed";

export interface SelfUpdateState {
  status: SelfUpdateStatus;
  startedAt?: number;
  completedAt?: number;
  message?: string;
}

const STATUS_FILE = path.join(DATA_DIR, ".server-update-status.json");
/** Tracks which GitHub main commit was last applied via Admin (Railway upstream equivalent). */
const UPSTREAM_STATE_FILE = path.join(DATA_DIR, ".upstream-deploy-state.json");

interface UpstreamDeployState {
  lastDeployedCommitSha?: string;
  lastCheckedCommitSha?: string;
  lastCheckedAtMillis?: number;
}

function readHostingMode(): ServerHostingMode {
  const stored = readStoredUpdateCredentials().hostingMode;
  const raw = (process.env.ROUTE47_HOSTING_MODE?.trim() || stored || "").toLowerCase();
  if (raw === "docker" || raw === "vps" || raw === "railway" || raw === "render") return raw;
  return "development";
}

export function getDeployHookUrl(): string {
  return (
    process.env.ROUTE47_DEPLOY_HOOK_URL?.trim() ||
    readStoredUpdateCredentials().deployHookUrl?.trim() ||
    ""
  );
}

/** Official server repo used when Railway should deploy the latest commit. */
const SERVER_GITHUB_REPO =
  process.env.ROUTE47_SERVER_GITHUB_REPO?.trim() || "sreeranj065/route47-server";
const SERVER_GITHUB_BRANCH =
  process.env.ROUTE47_SERVER_GITHUB_BRANCH?.trim() || "main";

export function getRailwayDeployConfig() {
  const stored = readStoredUpdateCredentials();
  const token =
    process.env.ROUTE47_RAILWAY_API_TOKEN?.trim() || stored.railwayApiToken?.trim() || "";
  const serviceId =
    process.env.ROUTE47_RAILWAY_SERVICE_ID?.trim() || stored.railwayServiceId?.trim() || "";
  const environmentId =
    process.env.ROUTE47_RAILWAY_ENVIRONMENT_ID?.trim() ||
    stored.railwayEnvironmentId?.trim() ||
    "";
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

function readUpstreamState(): UpstreamDeployState {
  try {
    return JSON.parse(fs.readFileSync(UPSTREAM_STATE_FILE, "utf8")) as UpstreamDeployState;
  } catch {
    return {};
  }
}

function writeUpstreamState(state: UpstreamDeployState) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(UPSTREAM_STATE_FILE, JSON.stringify(state));
}

export function markUpstreamDeployed(commitSha: string) {
  const prev = readUpstreamState();
  writeUpstreamState({
    ...prev,
    lastDeployedCommitSha: commitSha,
    lastCheckedCommitSha: commitSha,
    lastCheckedAtMillis: Date.now(),
  });
}

async function fetchLatestServerCommit(): Promise<{
  sha: string | null;
  message: string | null;
  htmlUrl: string | null;
}> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${SERVER_GITHUB_REPO}/commits/${encodeURIComponent(SERVER_GITHUB_BRANCH)}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return { sha: null, message: null, htmlUrl: null };
    const json = (await res.json()) as {
      sha?: string;
      html_url?: string;
      commit?: { message?: string };
    };
    return {
      sha: json.sha?.trim() || null,
      message: json.commit?.message?.trim().split("\n")[0] || null,
      htmlUrl: json.html_url ?? null,
    };
  } catch {
    return { sha: null, message: null, htmlUrl: null };
  }
}

async function fetchLatestServerCommitSha(): Promise<string | null> {
  const latest = await fetchLatestServerCommit();
  return latest.sha;
}

async function fetchGithubPackageVersion(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${SERVER_GITHUB_REPO}/${encodeURIComponent(SERVER_GITHUB_BRANCH)}/package.json`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return json.version?.trim() || null;
  } catch {
    return null;
  }
}

function isVersionNewer(latest: string, deployed: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(deployed);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

/**
 * Same intent as Railway Upstream → Check for updates:
 * Is GitHub main ahead of what this server last applied?
 */
export async function checkUpstreamRepoStatus(deployedVersion: string) {
  const latest = await fetchLatestServerCommit();
  const githubVersion = await fetchGithubPackageVersion();
  const state = readUpstreamState();

  writeUpstreamState({
    ...state,
    lastCheckedCommitSha: latest.sha ?? state.lastCheckedCommitSha,
    lastCheckedAtMillis: Date.now(),
  });

  let updateAvailable = false;
  if (latest.sha && state.lastDeployedCommitSha) {
    updateAvailable = latest.sha !== state.lastDeployedCommitSha;
  } else if (githubVersion && deployedVersion) {
    updateAvailable = isVersionNewer(githubVersion, deployedVersion);
  } else if (latest.sha && !state.lastDeployedCommitSha) {
    // First Admin check: if versions match, assume in sync and remember the sha.
    if (githubVersion && deployedVersion && !isVersionNewer(githubVersion, deployedVersion)) {
      markUpstreamDeployed(latest.sha);
      updateAvailable = false;
    } else {
      updateAvailable = true;
    }
  }

  return {
    repo: SERVER_GITHUB_REPO,
    branch: SERVER_GITHUB_BRANCH,
    updateAvailable,
    deployedVersion,
    latestVersion: githubVersion,
    latestCommitSha: latest.sha,
    latestCommitMessage: latest.message,
    latestCommitUrl: latest.htmlUrl,
    lastDeployedCommitSha: readUpstreamState().lastDeployedCommitSha ?? null,
    message: updateAvailable
      ? "Upstream GitHub main has newer code — same as Railway Upstream → Check for updates."
      : "Already on the latest upstream GitHub main commit.",
  };
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

    const sha = await fetchLatestServerCommitSha();
    if (sha) markUpstreamDeployed(sha);

    writeSelfUpdateState({
      status: "success",
      startedAt: Date.now(),
      completedAt: Date.now(),
      message: "Deploy triggered on Render (latest GitHub). Waiting for the new version…",
    });

    return {
      started: true,
      message: "Render deploy started from latest GitHub — same idea as Railway Upstream Update.",
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

    if (commitSha) {
      markUpstreamDeployed(commitSha);
    }

    writeSelfUpdateState({
      status: "success",
      startedAt: Date.now(),
      completedAt: Date.now(),
      message:
        "Railway upstream deploy started (latest GitHub main). Waiting for the new build to come online…",
    });

    return {
      started: true,
      message:
        "Update applied like Railway Upstream → Update. Deploying latest GitHub main — server will restart shortly.",
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
