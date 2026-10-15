import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function hasConfiguredSearchCredentialCandidate(searchConfig: unknown): boolean {
  const record = asOptionalObjectRecord(searchConfig);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(
    ([key, value]) => key !== "enabled" && hasConfiguredCredentialValue(value),
  );
}

function hasConfiguredPluginWebSearchCandidate(config: OpenClawConfig): boolean {
  return Object.values(config.plugins?.entries ?? {}).some((entry) => {
    const pluginConfig = entry.config;
    return hasConfiguredSearchCredentialCandidate(asOptionalObjectRecord(pluginConfig)?.webSearch);
  });
}

function hasManifestWebSearchEnvCredentialCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const env = params.env;
  if (!env) {
    return false;
  }
  return loadManifestMetadataSnapshot({
    config: params.config,
    env,
  }).plugins.some((plugin) => {
    if (params.origin && plugin.origin !== params.origin) {
      return false;
    }
    if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) {
      return false;
    }
    const envVars = (plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []);
    return envVars.some((envVar) => hasConfiguredCredentialValue(env[envVar]));
  });
}

export function hasConfiguredWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig?: Record<string, unknown>;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const searchConfig =
    params.searchConfig ??
    (params.config.tools?.web?.search as Record<string, unknown> | undefined);
  return (
    hasConfiguredSearchCredentialCandidate(searchConfig) ||
    hasConfiguredPluginWebSearchCandidate(params.config) ||
    hasManifestWebSearchEnvCredentialCandidate(params)
  );
}
