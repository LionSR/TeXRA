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

type ProxyLogger = { debug: (message: string) => void };

/**
 * The base-URL route for one API request, as a discriminated union over
 * `route` instead of a bag of optional booleans. Each variant carries exactly
 * the fields `resolveBaseUrl` needs for that route, so a caller can no longer
 * construct an ambiguous config (e.g. `useServerSideKeys: true` together with
 * `useOpenRouter: true`) — the precedence documented on `resolveBaseUrl`
 * (custom > server-side keys > everything else) is enforced by callers
 * picking exactly one variant, not by priority-ordered `if` checks inside the
 * resolver.
 *
 * The 'direct' variant covers the remaining precedence tiers (improved
 * connection proxy, OpenRouter, per-provider custom endpoint, provider
 * default): those aren't caller-selectable — which one applies depends on
 * global settings and provider metadata resolved inside `resolveBaseUrl` —
 * so they stay an internal cascade parameterized by `useOpenRouter`, the one
 * fact every call site already knows.
 */
export type ProxyConfig =
  | { route: 'custom'; url: string; logger?: ProxyLogger }
  | { route: 'serverSideKeys'; provider: ModelProvider; logger?: ProxyLogger }
  | {
      route: 'direct';
      provider: ModelProvider;
      useOpenRouter: boolean;
      logger?: ProxyLogger;
    };

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
 * 1. Custom base URL (per-model override) — `route: 'custom'`
 * 2. Server-side keys relay (experimental, for Ultra users) — `route: 'serverSideKeys'`
 * 3. Improved connection proxy (proxy.texra.ai)
 * 4. OpenRouter
 * 5. Per-provider custom endpoint (dashboard settings)
 * 6. Provider default URLs
 *
 * Tiers 3-6 are the internal cascade of `route: 'direct'` (see
 * {@link resolveDirectBaseUrl}): none of them is caller-selectable, since
 * which one applies depends on global settings and provider metadata read
 * here, not on a decision the caller has already made.
 *
 * Note: Server-side keys and proxy.texra.ai are MUTUALLY EXCLUSIVE.
 * When server-side keys are enabled, the relay handles everything
 * and proxy.texra.ai is not used — enforced structurally here since
 * `route: 'serverSideKeys'` and `route: 'direct'` cannot both be selected.
 */
export function resolveBaseUrl(config: ProxyConfig): string | null {
  switch (config.route) {
    // Per-model custom base URL (e.g., temporary endpoints).
    case 'custom':
      config.logger?.debug(`Using custom base URL for model: ${config.url}`);
      return config.url;

    // Server-side keys via relay (experimental feature for Ultra users).
    // The caller (ModelHandler.shouldUseServerSideKeys) pre-computes this
    // route to ensure consistency between URL routing and API key retrieval.
    case 'serverSideKeys': {
      const relayUrl = getServerSideKeyService().getRelayBaseUrl(
        config.provider,
      );
      config.logger?.debug(
        `Using server-side keys relay for ${config.provider}: ${relayUrl}`,
      );
      return relayUrl;
    }

    case 'direct':
      return resolveDirectBaseUrl(config);
  }
}

/**
 * The standard routing cascade used whenever neither a custom base URL nor
 * server-side keys apply: improved-connection proxy (if enabled and the
 * provider/route has a proxy path), then OpenRouter, then a per-provider
 * dashboard endpoint, then provider defaults (including region toggles).
 */
function resolveDirectBaseUrl(config: {
  provider: ModelProvider;
  useOpenRouter: boolean;
  logger?: ProxyLogger;
}): string | null {
  const { provider, useOpenRouter, logger } = config;
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
      logger?.debug(`Using default proxy domain: ${DEFAULT_PROXY_DOMAIN}`);
    }

    // OpenRouter uses 'openrouter' path; other providers use their configured paths
    const path = useOpenRouter ? 'openrouter' : PROXY_PATHS[provider];
    if (path) {
      logger?.debug(`Using proxy for ${provider}: ${domain}/${path}`);
      return `https://${domain}/${path}`;
    }
  }

  if (useOpenRouter) return 'https://openrouter.ai/api/v1';

  // Per-provider custom endpoint from dashboard settings (globalSM)
  const customUrl = getProviderEndpoint(provider);
  if (customUrl) {
    logger?.debug(`Using custom base URL for ${provider}: ${customUrl}`);
    return `https://${normalizeUrl(customUrl)}`;
  }

  // Providers with dynamic region-based URLs
  switch (provider) {
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
      return BASE_URLS[provider];
  }
}
