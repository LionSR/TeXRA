import { ModelProvider } from 'llm-zoo';
import {
  shouldRouteModelThroughOpenRouter,
  type ModelRoutingConfig,
} from '@model/openRouterRouting';
import { tryParseUrl } from '@utils/core';
import {
  getProviderEndpoint,
  useChinaRegion,
  getGLMCodingPlan,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

// Custom endpoints use the provider state written by the Models view.

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Normalize a URL-like string to `host/path` form (no protocol, no trailing slashes). */
function normalizeUrl(input: string): string {
  if (!input) return '';

  const withProtocol = input.includes('://') ? input : `https://${input}`;
  const parsed = tryParseUrl(withProtocol);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Provider default base URLs. Providers whose endpoint depends on the
 * China/international toggles supply a thunk, read only when that provider is
 * the one being resolved.
 */
const BASE_URLS: Record<ModelProvider, string | (() => string) | null> = {
  [ModelProvider.GOOGLE]: null,
  [ModelProvider.OPENAI]: null,
  [ModelProvider.ANTHROPIC]: null,
  [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
  [ModelProvider.XAI]: 'https://api.x.ai/v1',
  // China: api.moonshot.cn, International: api.moonshot.ai. Keys are
  // platform-specific. Kimi Code models never reach here — their directAccess
  // baseUrl wins as `route: 'custom'` at the top of the resolver.
  [ModelProvider.MOONSHOT]: () =>
    `https://${useChinaRegion('moonshot') ? 'api.moonshot.cn' : 'api.moonshot.ai'}/v1`,
  [ModelProvider.DASHSCOPE]: () =>
    `https://${
      useChinaRegion('dashscope')
        ? 'dashscope.aliyuncs.com'
        : 'dashscope-intl.aliyuncs.com'
    }/compatible-mode/v1`,
  // China: api.minimaxi.com (note the extra 'i'), International: api.minimax.io
  [ModelProvider.MINIMAX]: () =>
    `https://${useChinaRegion('minimax') ? 'api.minimaxi.com' : 'api.minimax.io'}/v1`,
  // Resolved separately below so the selected endpoint carries its usage
  // classification through asynchronous client construction.
  [ModelProvider.GLM]: null,
  [ModelProvider.META]: 'https://api.meta.ai/v1',
  [ModelProvider.COPILOT]: null,
  [ModelProvider.OTHERS]: null,
};

type ProxyLogger = { debug: (message: string) => void };

/**
 * The base-URL route for one API request, as a discriminated union over
 * `route` instead of a bag of optional booleans. Each variant carries exactly
 * the fields `resolveBaseUrl` needs for that route — the precedence
 * documented on `resolveBaseUrl` (custom > everything else) is enforced by
 * callers picking exactly one variant, not by priority-ordered `if` checks
 * inside the resolver.
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
 * Resolves the base URL for API requests.
 *
 * Priority order (mutually exclusive):
 * 1. Custom base URL (per-model override) — `route: 'custom'`
 * 2. OpenRouter
 * 3. Per-provider custom endpoint (dashboard settings)
 * 4. Provider default URLs
 *
 * Tiers 2-4 are the internal cascade of `route: 'direct'` (see
 * {@link resolveProxyEndpoint}): none of them is caller-selectable, since
 * which one applies depends on global settings and provider metadata read
 * here, not on a decision the caller has already made.
 */
export function resolveBaseUrl(config: ProxyConfig): string | null {
  return resolveProxyEndpoint(config).baseUrl;
}

export function resolveProxyEndpoint(config: ProxyConfig): {
  readonly baseUrl: string | null;
  readonly usageRoute?: 'glm-coding-plan-subscription';
} {
  switch (config.route) {
    // Per-model custom base URL (e.g., temporary endpoints).
    case 'custom':
      config.logger?.debug(`Using custom base URL for model: ${config.url}`);
      return { baseUrl: config.url };

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

  if (useOpenRouter) return { baseUrl: OPENROUTER_BASE_URL };

  // Per-provider custom endpoint from dashboard settings (globalSM)
  const customUrl = getProviderEndpoint(provider);
  if (customUrl) {
    logger?.debug(`Using custom base URL for ${provider}: ${customUrl}`);
    return { baseUrl: `https://${normalizeUrl(customUrl)}` };
  }

  if (provider === ModelProvider.GLM) {
    const codingPlan = getGLMCodingPlan();
    return {
      baseUrl: `https://${useChinaRegion('glm') ? 'open.bigmodel.cn' : 'api.z.ai'}${codingPlan ? '/api/coding/paas/v4' : '/api/paas/v4'}`,
      ...(codingPlan && {
        usageRoute: 'glm-coding-plan-subscription' as const,
      }),
    };
  }

  const baseUrl = BASE_URLS[provider];
  return { baseUrl: typeof baseUrl === 'function' ? baseUrl() : baseUrl };
}
