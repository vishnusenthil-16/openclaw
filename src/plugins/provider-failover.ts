import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveLoadedProviderRuntimePlugin,
  resolveLoadedProviderPluginsForHooks,
} from "./provider-hook-runtime.js";
import type { ProviderFailoverErrorContext, ProviderPlugin } from "./types.js";

// Error handling consumes prepared runtime. Cold discovery here can stall the
// event loop while an unrelated provider is loaded just to describe a failure.
export function classifyProviderFailoverSignalWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}) {
  const plugins = resolveProviderPluginsForScopedHook(params);
  for (const plugin of plugins) {
    if (plugin.matchesContextOverflowError?.(params.context)) {
      return "context_overflow";
    }
    const reason = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function resolveProviderPluginsForScopedHook(
  params: Parameters<typeof classifyProviderFailoverSignalWithPlugin>[0],
): ProviderPlugin[] {
  if (!params.provider) {
    return resolveLoadedProviderPluginsForHooks(params) ?? [];
  }
  const plugin = resolveLoadedProviderRuntimePlugin({ ...params, provider: params.provider });
  if (plugin) {
    return [plugin];
  }
  if (hasStructuredFailoverDescriptor(params.context)) {
    return [];
  }
  // Descriptor-free custom routes can consult other loaded hooks, but unrelated
  // providers must not override structured HTTP/auth signals.
  return resolveLoadedProviderPluginsForHooks(params) ?? [];
}

function hasStructuredFailoverDescriptor(context: ProviderFailoverErrorContext): boolean {
  return (
    context.status !== undefined || context.code !== undefined || context.errorType !== undefined
  );
}
