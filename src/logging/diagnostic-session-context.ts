import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prepareCronJobNameResolver } from "../cron/store/job-name.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  isIncognitoSessionKey,
  isValidAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";

type SessionDiagnosticContext = {
  cronJobId?: string;
  cronRunId?: string;
  cronJobName?: string;
};

type SessionDiagnosticTarget = {
  sessionKey?: string;
  activeSessionId?: string;
};

let logGeneration = 0;

export function retireSessionDiagnosticLogs(): void {
  logGeneration += 1;
}

async function resolveSessionDiagnosticContext(
  params: SessionDiagnosticTarget,
): Promise<SessionDiagnosticContext> {
  const sessionKey = params.sessionKey?.trim();
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !sessionKey ||
    !parsed ||
    !isValidAgentId(parsed.agentId) ||
    isIncognitoSessionKey(sessionKey)
  ) {
    return {};
  }
  const [kind, cronJobId, ...rest] = parsed.rest.split(":");
  const runIndex = rest.indexOf("run");
  const context: SessionDiagnosticContext =
    kind === "cron" && cronJobId
      ? { cronJobId, cronRunId: runIndex >= 0 ? rest[runIndex + 1] : undefined }
      : {};
  if (context.cronJobId) {
    // Names are optional job metadata, not session content or live session authority.
    try {
      const resolveName = await prepareCronJobNameResolver([context.cronJobId]);
      context.cronJobName = resolveName(context.cronJobId);
    } catch {
      // Missing or retired cron metadata must not suppress the recovery diagnostic.
    }
  }
  return context;
}

function formatSessionDiagnosticFields(
  context: SessionDiagnosticContext,
  cronNameLabel: "cronJob" | "stopped" = "cronJob",
): string {
  const quote = (value: string) => {
    const oneLine = value.replace(/\s+/g, " ").trim();
    const bounded = oneLine.length > 140 ? `${truncateUtf16Safe(oneLine, 137)}...` : oneLine;
    return `"${bounded.replace(/["\\]/g, "\\$&")}"`;
  };
  return [
    context.cronJobId ? `cronJobId=${context.cronJobId}` : "",
    context.cronRunId ? `cronRunId=${context.cronRunId}` : "",
    context.cronJobName ? `${cronNameLabel}=${quote(context.cronJobName)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Recovery and event publication never wait for optional display enrichment. */
export function logWithSessionDiagnosticContext(
  params: SessionDiagnosticTarget & {
    level: "debug" | "warn";
    format: (fields: string) => string;
    cronNameLabel?: "cronJob" | "stopped";
  },
): Promise<void> | undefined {
  const generation = logGeneration;
  const isCurrent = () => areDiagnosticsEnabledForProcess() && generation === logGeneration;
  if (!isCurrent() || !diag.isEnabled(params.level)) {
    return undefined;
  }
  return resolveSessionDiagnosticContext(params).then((context) => {
    if (isCurrent() && diag.isEnabled(params.level)) {
      diag[params.level](
        params.format(formatSessionDiagnosticFields(context, params.cronNameLabel)),
      );
    }
  });
}
