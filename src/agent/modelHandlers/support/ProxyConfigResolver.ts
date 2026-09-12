import { ModelProvider } from 'llm-zoo';
import { BASE_URLS } from '@agent/runtime/run/routeEndpoint';
import { resolveGlmRoute } from '@model/glmRouting';
import { OPENROUTER_BASE_URL } from '@model/openRouterEndpoint';
import { normalizeProviderEndpoint } from '@model/providerEndpoint';
import {
  shouldRouteModelThroughOpenRouter,
  type ModelRoutingConfig,
} from '@model/openRouterRouting';
import {
  getProviderEndpoint,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

type ProxyLogger = { debug: (message: string) => void };

/**
 * The base-URL route for one API request, as a discriminated union over
 * `route` instead of a bag of optional booleans. Each variant carries exactly
 * the fields `resolveProxyEndpoint` needs for that route — the precedence
 * documented on `resolveProxyEndpoint` (custom > everything else) is enforced
 * by callers picking exactly one variant, not by priority-ordered `if` checks
 * inside the resolver.
 *
 * The 'direct' variant covers the remaining precedence tiers (improved
 * connection proxy, OpenRouter, per-provider custom endpoint, provider
 * default): those aren't caller-selectable — which one applies depends on
 * global settings and provider metadata resolved inside
 * `resolveProxyEndpoint` — so they stay an internal cascade parameterized by
 * `useOpenRouter`, the one fact every call site already knows.
 */
export type ProxyConfig =
  | {
      route: 'custom';
      provider: ModelProvider;
      url: string;
      logger?: ProxyLogger;
    }
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
 * Resolves the base URL (and any usage classification) for API requests.
 *
 * Priority order (mutually exclusive):
 * 1. Custom base URL (per-model override) — `route: 'custom'`
 * 2. OpenRouter
 * 3. Per-provider custom endpoint (dashboard settings)
 * 4. Provider default URLs
 *
 * Tiers 2-4 are the internal cascade of `route: 'direct'`: none of them is
 * caller-selectable, since which one applies depends on global settings and
 * provider metadata read here, not on a decision the caller has already made.
 */
export function resolveProxyEndpoint(config: ProxyConfig): {
  readonly baseUrl: string | null;
  readonly usageRoute?: 'glm-coding-plan-subscription';
} {
  switch (config.route) {
    // Per-model custom base URL (e.g., temporary endpoints).
    case 'custom': {
      config.logger?.debug(`Using custom base URL for model: ${config.url}`);
      if (config.provider === ModelProvider.GLM) {
        const route = resolveGlmRoute({
          baseUrl: config.url,
          useOpenRouter: false,
        });
        return { baseUrl: route.baseUrl };
      }
      return { baseUrl: config.url };
    }

    case 'direct':
      return resolveDirectEndpoint(config);
  }
}

/**
 * The standard routing cascade used whenever neither a custom base URL nor
 * server-side keys apply: OpenRouter, then a per-provider dashboard endpoint,
 * then provider defaults (including region toggles).
 */
function resolveDirectEndpoint(config: {
  provider: ModelProvider;
  useOpenRouter: boolean;
  logger?: ProxyLogger;
}): {
  readonly baseUrl: string | null;
  readonly usageRoute?: 'glm-coding-plan-subscription';
} {
  const { provider, useOpenRouter, logger } = config;

  if (provider === ModelProvider.GLM) {
    const route = resolveGlmRoute({ useOpenRouter });
    if (route.route === 'provider-custom') {
      logger?.debug(`Using custom base URL for ${provider}: ${route.baseUrl}`);
    }
    return {
      baseUrl: route.baseUrl,
      ...(route.route === 'official-coding-plan' && {
        usageRoute: route.usageRoute,
      }),
    };
  }

  if (useOpenRouter) return { baseUrl: OPENROUTER_BASE_URL };

  // Per-provider custom endpoint from dashboard settings (global state)
  const customUrl = getProviderEndpoint(provider);
  if (customUrl) {
    logger?.debug(`Using custom base URL for ${provider}: ${customUrl}`);
    return { baseUrl: `https://${normalizeProviderEndpoint(customUrl)}` };
  }

  const baseUrl = BASE_URLS[provider];
  return { baseUrl: typeof baseUrl === 'function' ? baseUrl() : baseUrl };
}
