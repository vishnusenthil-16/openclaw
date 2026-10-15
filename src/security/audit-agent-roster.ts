import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasAgentRosterProperty,
  listAgentEntries,
  readAgentRosterProperty,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type AuditAgentToolContext = {
  label: string;
  agentId?: string;
  tools?: AgentToolsConfig;
};

export function* listAuditAgentToolContexts(
  cfg: OpenClawConfig,
  defaultLabel = "agents.defaults",
  agentLabelSuffix = "",
): Generator<AuditAgentToolContext> {
  yield { label: defaultLabel };
  for (const agent of listAgentEntries(cfg)) {
    // Raw legacy roster objects are projected without validating their IDs.
    if (typeof agent.id !== "string") {
      continue;
    }
    yield {
      label: `agents.entries.${agent.id}${agentLabelSuffix}`,
      agentId: agent.id,
      tools: agent.tools,
    };
  }
}

export function collectAgentRosterFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const agents = listAgentEntries(cfg);
  // A missing roster is the supported pre-roster compatibility state and is
  // materialized by config loading. An explicitly authored empty roster is invalid.
  if (agents.length === 0 && !hasAgentRosterProperty(cfg)) {
    return [];
  }
  const roster = readAgentRosterProperty(cfg);
  const rawAgents: unknown[] =
    roster?.kind === "entries"
      ? Object.values(asNullableRecord(roster.value) ?? {})
      : Array.isArray(roster?.value)
        ? roster.value
        : [];
  const defaultCount = rawAgents.filter(
    (agent) => asNullableRecord(agent)?.default === true,
  ).length;
  const explicitOwnership = cfg.agents?.ownership === "explicit";
  // Mirror runtime default resolution: explicit fleets are ownerless by design,
  // otherwise the roster is valid exactly when the canonical resolver finds an
  // owner (sole agent or one raw legacy marker).
  const resolvable = explicitOwnership
    ? defaultCount === 0
    : tryResolveLegacyCompatibilityAgentId(cfg) !== undefined;
  if (resolvable) {
    return [];
  }
  return [
    {
      checkId: "config.agent_roster.invalid_default_count",
      severity: "warn",
      title: "Agent roster has an invalid default selection",
      detail: explicitOwnership
        ? `Expected no agents.entries default=true entries with agents.ownership=explicit, found ${defaultCount}.`
        : `Expected a resolvable default agent (sole entry, one default=true marker, or agents.ownership=explicit); found ${defaultCount} default markers across ${agents.length} configured agents.`,
      remediation: "Run `openclaw doctor --fix` to repair the authored agent roster.",
    },
  ];
}
