import path from "node:path";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { resolveAuthProfileDatabaseFilePaths } from "../agents/auth-profiles/sqlite.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveOAuthDir } from "../config/paths.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { createLazyRuntimeModule, createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import type { ExecFn } from "./windows-acl.js";

type ExecDockerRawFn = typeof import("../agents/sandbox/docker.js").execDockerRaw;
type DockerProbeOptions = {
  execDockerRawFn: ExecDockerRawFn;
  timeoutMs: number;
  onTimeout?: () => void;
};

const DEFAULT_SANDBOX_BROWSER_DOCKER_PROBE_TIMEOUT_MS = 5000;

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

const loadAuditFsModule = createLazyRuntimeModule(() => import("./audit-fs.js"));

const loadAgentScopeModule = createLazyRuntimeModule(() => import("../agents/agent-scope.js"));

const loadExecDockerRaw = createLazyRuntimeNamedExport(
  () => import("../agents/sandbox/docker.js"),
  "execDockerRaw",
) satisfies () => Promise<ExecDockerRawFn>;

const loadSandboxBrowserSecurityHashEpoch = createLazyRuntimeNamedExport(
  () => import("../agents/sandbox/constants.js"),
  "SANDBOX_BROWSER_SECURITY_HASH_EPOCH",
);

function expandTilde(p: string, env: NodeJS.ProcessEnv): string | null {
  if (!p.startsWith("~")) {
    return p;
  }
  const home = normalizeOptionalString(env.HOME) ?? null;
  if (!home) {
    return null;
  }
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(home, p.slice(2));
  }
  return null;
}

function normalizeDockerLabelValue(raw: string | undefined): string | null {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed || trimmed === "<no value>") {
    return null;
  }
  return trimmed;
}

class DockerProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Docker check timed out after ${timeoutMs}ms`);
    this.name = "DockerProbeTimeoutError";
  }
}

function normalizeDockerProbeTimeoutMs(timeoutMs: number | undefined): number {
  if (Number.isFinite(timeoutMs) && timeoutMs !== undefined) {
    return Math.max(250, Math.floor(timeoutMs));
  }
  return DEFAULT_SANDBOX_BROWSER_DOCKER_PROBE_TIMEOUT_MS;
}

async function withDockerProbeTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      controller.abort();
      reject(new DockerProbeTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeoutPromise]);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new DockerProbeTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearNodeTimeout(timeout);
  }
}

async function readSandboxBrowserDocker<T>(
  params: DockerProbeOptions,
  args: string[],
  parse: (stdout: string) => T,
): Promise<T | null> {
  try {
    const result = await withDockerProbeTimeout(params.timeoutMs, (signal) =>
      params.execDockerRawFn(args, { allowFailure: true, signal }),
    );
    if (result.code !== 0) {
      return null;
    }
    return parse(result.stdout.toString("utf8"));
  } catch (err) {
    if (err instanceof DockerProbeTimeoutError) {
      params.onTimeout?.();
    }
    return null;
  }
}

function readDockerOutputLines(stdout: string): string[] {
  return normalizeStringEntries(stdout.split(/\r?\n/));
}

function parsePublishedHostFromDockerPortLine(line: string): string | null {
  const trimmed = normalizeOptionalString(line) ?? "";
  const rhs = trimmed.includes("->")
    ? (normalizeOptionalString(trimmed.split("->").at(-1)) ?? "")
    : trimmed;
  if (!rhs) {
    return null;
  }
  const bracketHost = rhs.match(/^\[([^\]]+)\]:\d+$/);
  if (bracketHost?.[1]) {
    return bracketHost[1];
  }
  const hostPort = rhs.match(/^([^:]+):\d+$/);
  if (hostPort?.[1]) {
    return hostPort[1];
  }
  return null;
}

function isLoopbackPublishHost(host: string): boolean {
  const normalized = normalizeOptionalLowercaseString(host);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export async function collectSandboxBrowserHashLabelFindings(params?: {
  execDockerRawFn?: ExecDockerRawFn;
  timeoutMs?: number;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const timeoutMs = normalizeDockerProbeTimeoutMs(params?.timeoutMs);
  let timedOut = false;
  const markTimedOut = () => {
    timedOut = true;
  };
  const [execFn, browserHashEpoch] = await Promise.all([
    params?.execDockerRawFn ? Promise.resolve(params.execDockerRawFn) : loadExecDockerRaw(),
    loadSandboxBrowserSecurityHashEpoch(),
  ]);
  const probeOptions: DockerProbeOptions = {
    execDockerRawFn: execFn,
    timeoutMs,
    onTimeout: markTimedOut,
  };
  const containers = await readSandboxBrowserDocker(
    probeOptions,
    ["ps", "-a", "--filter", "label=openclaw.sandboxBrowser=1", "--format", "{{.Names}}"],
    readDockerOutputLines,
  );
  if (!containers || containers.length === 0) {
    if (timedOut) {
      findings.push(buildSandboxBrowserDockerProbeTimeoutFinding(timeoutMs));
    }
    return findings;
  }

  const missingHash: string[] = [];
  const staleEpoch: string[] = [];
  const nonLoopbackPublished: string[] = [];

  for (const containerName of containers) {
    const labels = await readSandboxBrowserDocker(
      probeOptions,
      [
        "inspect",
        "-f",
        '{{ index .Config.Labels "openclaw.configHash" }}\t{{ index .Config.Labels "openclaw.browserConfigEpoch" }}',
        containerName,
      ],
      (stdout) => {
        const [hashRaw, epochRaw] = stdout.split("\t");
        return {
          configHash: normalizeDockerLabelValue(hashRaw),
          epoch: normalizeDockerLabelValue(epochRaw),
        };
      },
    );
    if (timedOut) {
      break;
    }
    if (!labels) {
      continue;
    }
    if (!labels.configHash) {
      missingHash.push(containerName);
    }
    if (labels.epoch !== browserHashEpoch) {
      staleEpoch.push(containerName);
    }
    const portMappings = await readSandboxBrowserDocker(
      probeOptions,
      ["port", containerName],
      readDockerOutputLines,
    );
    if (timedOut) {
      break;
    }
    if (!portMappings?.length) {
      continue;
    }
    const exposedMappings = portMappings.filter((line) => {
      const host = parsePublishedHostFromDockerPortLine(line);
      return Boolean(host && !isLoopbackPublishHost(host));
    });
    if (exposedMappings.length > 0) {
      nonLoopbackPublished.push(`${containerName} (${exposedMappings.join("; ")})`);
    }
  }

  if (missingHash.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.hash_label_missing",
      severity: "warn",
      title: "Sandbox browser container missing config hash label",
      detail:
        `Containers: ${missingHash.join(", ")}. ` +
        "These browser containers predate hash-based drift checks and may miss security remediations until recreated.",
      remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`,
    });
  }

  if (staleEpoch.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.hash_epoch_stale",
      severity: "warn",
      title: "Sandbox browser container hash epoch is stale",
      detail:
        `Containers: ${staleEpoch.join(", ")}. ` +
        `Expected openclaw.browserConfigEpoch=${browserHashEpoch}.`,
      remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`,
    });
  }

  if (nonLoopbackPublished.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.non_loopback_publish",
      severity: "critical",
      title: "Sandbox browser container publishes ports on non-loopback interfaces",
      detail:
        `Containers: ${nonLoopbackPublished.join(", ")}. ` +
        "Sandbox browser observer/control ports should stay loopback-only to avoid unintended remote access.",
      remediation:
        `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt), ` +
        "then verify published ports are bound to 127.0.0.1.",
    });
  }

  if (timedOut) {
    findings.push(buildSandboxBrowserDockerProbeTimeoutFinding(timeoutMs));
  }

  return findings;
}

function buildSandboxBrowserDockerProbeTimeoutFinding(timeoutMs: number): SecurityAuditFinding {
  return {
    checkId: "sandbox.browser_container.docker_probe_timeout",
    severity: "warn",
    title: "Sandbox browser Docker audit check timed out",
    detail:
      `Docker did not answer within ${timeoutMs}ms while checking sandbox browser containers. ` +
      "OpenClaw skipped any remaining sandbox browser container drift checks for this status run.",
    remediation:
      "Retry after Docker is responsive, or recreate sandbox browser containers if drift is suspected.",
  };
}

export async function collectIncludeFilePermFindings(params: {
  configSnapshot: ConfigFileSnapshot;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  if (!params.configSnapshot.exists) {
    return findings;
  }

  const configPath = params.configSnapshot.path;
  const includePaths = await collectIncludePathsRecursive({
    configPath,
    parsed: params.configSnapshot.parsed,
    env: params.env,
  });
  if (includePaths.length === 0) {
    return findings;
  }

  const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } =
    await loadAuditFsModule();

  for (const p of includePaths) {
    const perms = await inspectPathPermissions(p, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) {
      continue;
    }
    let finding: SecurityAuditFinding | undefined;
    if (perms.worldWritable || perms.groupWritable) {
      finding = {
        checkId: "fs.config_include.perms_writable",
        severity: "critical",
        title: "Config include file is writable by others",
        detail: `${formatPermissionDetail(p, perms)}; another user could influence your effective config.`,
      };
    } else if (perms.worldReadable) {
      finding = {
        checkId: "fs.config_include.perms_world_readable",
        severity: "critical",
        title: "Config include file is world-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
      };
    } else if (perms.groupReadable) {
      finding = {
        checkId: "fs.config_include.perms_group_readable",
        severity: "warn",
        title: "Config include file is group-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
      };
    }
    if (finding) {
      findings.push({
        ...finding,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    }
  }

  return findings;
}

export async function collectStateDeepFilesystemFindings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const oauthDir = resolveOAuthDir(params.env, params.stateDir);
  const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } =
    await loadAuditFsModule();

  const inspectTarget = async (
    targetPath: string,
    target: {
      checkId: string;
      label: string;
      readableDetail: string;
      writableDetail?: string;
      isDir?: true;
    },
  ): Promise<void> => {
    const perms = await inspectPathPermissions(targetPath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok || (target.isDir && !perms.isDir)) {
      return;
    }
    const writable = target.writableDetail && (perms.worldWritable || perms.groupWritable);
    if (!writable && !perms.worldReadable && !perms.groupReadable) {
      return;
    }
    const access = writable ? "writable" : "readable";
    findings.push({
      checkId: `${target.checkId}.perms_${access}`,
      severity: writable ? "critical" : "warn",
      title: `${target.label} is ${access} by others`,
      detail: `${formatPermissionDetail(targetPath, perms)}; ${writable ? target.writableDetail : target.readableDetail}`,
      remediation: formatPermissionRemediation({
        targetPath,
        perms,
        isDir: target.isDir === true,
        posixMode: target.isDir ? 0o700 : 0o600,
        env: params.env,
      }),
    });
  };

  await inspectTarget(oauthDir, {
    checkId: "fs.credentials_dir",
    label: "Credentials dir",
    writableDetail: "another user could drop/modify credential files.",
    readableDetail: "credentials and allowlists can be sensitive.",
    isDir: true,
  });

  const agentScope = await loadAgentScopeModule();
  const agentIds = agentScope.listAgentEntries(params.cfg).map((agent) => agent.id);
  let defaultAgentId: string | undefined;
  if (agentIds.length > 0) {
    try {
      defaultAgentId = agentScope.resolveDefaultAgentId(params.cfg);
    } catch {
      // Security audits must still inspect known agent stores when a malformed
      // roster prevents normal default selection; config findings report that defect.
    }
  }
  const ids = uniqueStrings([
    LEGACY_IMPLICIT_AGENT_ID,
    ...(defaultAgentId ? [defaultAgentId] : []),
    ...agentIds,
  ]).map((id) => normalizeAgentId(id));

  for (const agentId of ids) {
    const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
    const authTargets = [
      { path: path.join(agentDir, "auth-profiles.json"), label: "legacy auth-profiles.json" },
      ...resolveAuthProfileDatabaseFilePaths(agentDir).map((targetPath) => ({
        path: targetPath,
        label: "auth profile SQLite store",
      })),
    ];
    for (const authTarget of authTargets) {
      await inspectTarget(authTarget.path, {
        checkId: "fs.auth_profiles",
        label: authTarget.label,
        writableDetail: "another user could inject credentials.",
        readableDetail: "auth profile storage contains API keys and OAuth tokens.",
      });
    }

    const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
    await inspectTarget(storePath, {
      checkId: "fs.sessions_store",
      label: "sessions.json",
      readableDetail: "routing and transcript metadata can be sensitive.",
    });
  }

  const logFile = normalizeOptionalString(params.cfg.logging?.file) ?? "";
  if (logFile) {
    const expanded = logFile.startsWith("~") ? expandTilde(logFile, params.env) : logFile;
    if (expanded) {
      const logPath = path.resolve(expanded);
      await inspectTarget(logPath, {
        checkId: "fs.log_file",
        label: "Log file",
        readableDetail: "logs can contain private messages and tool output.",
      });
    }
  }

  return findings;
}

export async function readConfigSnapshotForAudit(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}): Promise<ConfigFileSnapshot> {
  const { createConfigIO } = await loadConfigModule();
  return await createConfigIO({
    env: params.env,
    configPath: params.configPath,
  }).readConfigFileSnapshot();
}
