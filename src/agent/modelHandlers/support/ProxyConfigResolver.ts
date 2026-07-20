import { ModelProvider } from 'llm-zoo';
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  allowsModelRelay,
  shouldRouteModelThroughOpenRouter,
  type ModelRoutingConfig,
} from '@model/openRouterRouting';
import { tryParseUrl } from '@utils/core';
import { getConfig } from '@utils/config/configUtils';
import {
  getProviderEndpoint,
  getDashScopeUseChina,
  getMiniMaxUseChina,
  getMoonshotUseChina,
  getGLMUseChina,
  getGLMCodingPlan,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

// NOTE: getProviderEndpoint reads from globalSM (VS Code global state), which is
// where the Settings dashboard writes custom endpoints. The legacy settings.json
// keys (texra.model.baseUrl*) are no longer read — globalSM is the single source.

const DEFAULT_PROXY_DOMAIN = 'proxy.texra.ai';

/** Normalize a URL-like string to `host/path` form (no protocol, no trailing slashes). */
function normalizeUrl(input: string): string {
  if (!input) return '';

  const withProtocol = input.includes('://') ? input : `https://${input}`;
  const parsed = tryParseUrl(withProtocol);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

const PROXY_PATHS: Partial<Record<ModelProvider, string>> = {
  [ModelProvider.GOOGLE]: 'generativelanguage',
  [ModelProvider.OPENAI]: 'openai/v1',
  [ModelProvider.ANTHROPIC]: 'anthropic',
  [ModelProvider.XAI]: 'xai',
};

const BASE_URLS: Record<ModelProvider, string | null> = {
  [ModelProvider.GOOGLE]: null,
  [ModelProvider.OPENAI]: null,
  [ModelProvider.ANTHROPIC]: null,
  [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
  [ModelProvider.XAI]: 'https://api.x.ai/v1',
  [ModelProvider.MOONSHOT]: null, // Resolved dynamically (China/international toggle)
  [ModelProvider.DASHSCOPE]: null, // Resolved dynamically (China/international toggle)
  [ModelProvider.MINIMAX]: null, // Resolved dynamically (China/international toggle)
  [ModelProvider.GLM]: null, // Resolved dynamically (China/international toggle)
  [ModelProvider.META]: 'https://api.meta.ai/v1',
  [ModelProvider.COPILOT]: null,
  [ModelProvider.OTHERS]: null,
};

interface ProxyConfig {
  provider: ModelProvider;
  openRouterOnly: boolean;
  customBaseUrl?: string; // Per-model custom base URL (overrides provider default)
  requiresResponsesAPI?: boolean; // Models requiring direct API access (bypasses OpenRouter)
  forceDirectProvider?: boolean; // Runtime replay override that bypasses OpenRouter
  useServerSideKeys?: boolean; // Pre-computed by caller to avoid duplicated checks
  useOpenRouter?: boolean; // Pre-computed by client construction for an atomic route snapshot
  logger?: { debug: (message: string) => void };
}

/**
 * Determines whether OpenRouter should be used for API routing.
 * Models with requiresResponsesAPI bypass OpenRouter even if globally enabled.
 */
export function shouldUseOpenRouter(config: ModelRoutingConfig): boolean {
  return shouldRouteModelThroughOpenRouter(config, getUseOpenRouter());
}

/**
 * Determines whether server-side (relay) API keys should be used for a model:
 * the OpenRouter-routing gate (relay is a direct-provider path, never an
 * OpenRouter path) combined with the server-side key service's synchronous
 * tier/access check.
 *
 * Centralized here (#7101 triage — "runtime combinator over profile data")
 * so callers that only have a plain `ModelConfig`-shaped value, not a full
 * `ModelHandler` instance — e.g. `UsageMonitor`, which deliberately avoids
 * holding an `IModelHandler` reference (see `UsageMonitorModelInfo`'s doc
 * comment) — read the same combinator `ModelHandler.shouldUseServerSideKeys()`
 * delegates to, instead of re-deriving the `!openRouter && relaySync` formula
 * independently and risking drift.
 */
export function usesServerSideKeysRoute(
  config: ModelRoutingConfig & {
    provider: ModelProvider;
    name: string;
  },
): boolean {
  if (!allowsModelRelay(config)) return false;
  if (shouldUseOpenRouter(config)) {
    return false;
  }
  return getServerSideKeyService().shouldUseServerSideKeysSync(
    config.provider,
    config.name,
  );
}

/**
 * Resolves the base URL for API requests.
 *
 * Priority order (mutually exclusive):
 * 1. Custom base URL (per-model override)
 * 2. Server-side keys relay (experimental, for Ultra users)
 * 3. Improved connection proxy (proxy.texra.ai)
 * 4. OpenRouter
 * 5. Per-provider custom endpoint (dashboard settings)
 * 6. Provider default URLs
 *
 * Note: Server-side keys and proxy.texra.ai are MUTUALLY EXCLUSIVE.
 * When server-side keys are enabled, the relay handles everything
 * and proxy.texra.ai is not used.
 */
export function resolveBaseUrl(config: ProxyConfig): string | null {
  // Per-model custom base URL takes highest precedence (e.g., temporary endpoints)
  if (config.customBaseUrl) {
    config.logger?.debug(
      `Using custom base URL for model: ${config.customBaseUrl}`,
    );
    return config.customBaseUrl;
  }

  // Server-side keys via relay (experimental feature for Ultra users)
  // IMPORTANT: This path is MUTUALLY EXCLUSIVE with proxy.texra.ai.
  // When server-side keys are enabled, we use the Supabase Edge Function relay
  // which handles everything directly - no intermediate proxy is used.
  //
  // The caller (ModelHandler.shouldUseServerSideKeys) pre-computes this decision
  // to ensure consistency between URL routing and API key retrieval.
  if (config.useServerSideKeys) {
    const relayUrl = getServerSideKeyService().getRelayBaseUrl(config.provider);
    config.logger?.debug(
      `Using server-side keys relay for ${config.provider}: ${relayUrl}`,
    );
    return relayUrl;
  }

  // Below this point: standard routing (proxy.texra.ai, OpenRouter, or direct)
  // These paths are only used when server-side keys are NOT enabled.

  const useOpenRouter = config.useOpenRouter ?? shouldUseOpenRouter(config);
  const useImprovedConnection = getConfig<boolean>(
    'texra.model.useImprovedConnection',
    false,
  );

  if (useImprovedConnection) {
    const customDomain = getConfig<string>(
      'texra.model.improvedConnectionDomain',
      '',
    ).trim();
    const domain = normalizeUrl(customDomain || DEFAULT_PROXY_DOMAIN);

    if (!customDomain) {
      config.logger?.debug(
        `Using default proxy domain: ${DEFAULT_PROXY_DOMAIN}`,
      );
    }

    // OpenRouter uses 'openrouter' path; other providers use their configured paths
    const path = useOpenRouter ? 'openrouter' : PROXY_PATHS[config.provider];
    if (path) {
      config.logger?.debug(
        `Using proxy for ${config.provider}: ${domain}/${path}`,
      );
      return `https://${domain}/${path}`;
    }
  }

  if (useOpenRouter) return 'https://openrouter.ai/api/v1';

  // Per-provider custom endpoint from dashboard settings (globalSM)
  const customUrl = getProviderEndpoint(config.provider);
  if (customUrl) {
    config.logger?.debug(
      `Using custom base URL for ${config.provider}: ${customUrl}`,
    );
    return `https://${normalizeUrl(customUrl)}`;
  }

  // Providers with dynamic region-based URLs
  switch (config.provider) {
    case ModelProvider.DASHSCOPE: {
      const domain = getDashScopeUseChina()
        ? 'dashscope.aliyuncs.com'
        : 'dashscope-intl.aliyuncs.com';
      return `https://${domain}/compatible-mode/v1`;
    }
    case ModelProvider.MINIMAX: {
      // China: api.minimaxi.com (note the extra 'i'), International: api.minimax.io
      const domain = getMiniMaxUseChina()
        ? 'api.minimaxi.com'
        : 'api.minimax.io';
      return `https://${domain}/v1`;
    }
    case ModelProvider.MOONSHOT: {
      // China: api.moonshot.cn, International: api.moonshot.ai. Keys are
      // platform-specific. Kimi Code models never reach this switch — their
      // directAccess baseUrl wins as customBaseUrl at the top of this resolver.
      const domain = getMoonshotUseChina()
        ? 'api.moonshot.cn'
        : 'api.moonshot.ai';
      return `https://${domain}/v1`;
    }
    case ModelProvider.GLM: {
      // China: open.bigmodel.cn, International: api.z.ai
      const domain = getGLMUseChina() ? 'open.bigmodel.cn' : 'api.z.ai';
      const path = getGLMCodingPlan() ? '/api/coding/paas/v4' : '/api/paas/v4';
      return `https://${domain}${path}`;
    }
    default:
      return BASE_URLS[config.provider];
  }
}
