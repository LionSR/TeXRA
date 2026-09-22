import { Effect } from 'effect';
/**
 * The endpoint of one model route, resolved as an explicit URL. The package
 * binds a model to a stated deployment endpoint (it never falls back to an
 * SDK default), so the providers the handler left to their SDKs are named
 * here. Precedence is the handler resolver's, unchanged: a per-model base
 * URL, then GLM's own route table, then OpenRouter, then a per-provider
 * dashboard endpoint, then the provider default.
 */
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { resolveGlmRoute } from '@model/glmRouting';
import { OPENROUTER_BASE_URL } from '@model/openRouterEndpoint';
import { normalizeProviderEndpoint } from '@model/providerEndpoint';
import type { StateReadFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { DeclinableUsageRoute, UsageRoute } from '@shared/schemas';
import {
  getProviderEndpoint,
  useChinaRegion,
} from '@utils/config/providerConfig';

/**
 * OpenAI's own endpoint. Named because a route that lands on it is the one
 * the Responses WebSocket transport is known to serve: a per-model or
 * dashboard endpoint may not speak it at all.
 */
export const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/**
 * Provider default base URLs; region-dependent ones resolve at read time, from
 * the setting slots the caller answers for.
 */
const BASE_URLS: Record<
  ModelProvider,
  | string
  | ((stores: SettingsStores) => Effect.Effect<string, StateReadFailed>)
  | null
> = {
  [ModelProvider.GOOGLE]: 'https://generativelanguage.googleapis.com',
  [ModelProvider.OPENAI]: OPENAI_DEFAULT_ENDPOINT,
  [ModelProvider.ANTHROPIC]: 'https://api.anthropic.com',
  [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
  [ModelProvider.XAI]: 'https://api.x.ai/v1',
  // China: api.moonshot.cn, International: api.moonshot.ai. Keys are
  // platform-specific. Kimi Code models never reach here: their coding
  // baseUrl wins as the per-model override.
  [ModelProvider.MOONSHOT]: (stores) =>
    useChinaRegion(stores, 'moonshot').pipe(
      Effect.map(
        (china) =>
          `https://${china ? 'api.moonshot.cn' : 'api.moonshot.ai'}/v1`,
      ),
    ),
  [ModelProvider.DASHSCOPE]: (stores) =>
    useChinaRegion(stores, 'dashscope').pipe(
      Effect.map(
        (china) =>
          `https://${china ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com'}/compatible-mode/v1`,
      ),
    ),
  // China: api.minimaxi.com (note the extra 'i'), International: api.minimax.io
  [ModelProvider.MINIMAX]: (stores) =>
    useChinaRegion(stores, 'minimax').pipe(
      Effect.map(
        (china) =>
          `https://${china ? 'api.minimaxi.com' : 'api.minimax.io'}/v1`,
      ),
    ),
  // Resolved by `resolveGlmRoute`, which carries the usage classification.
  [ModelProvider.GLM]: null,
  [ModelProvider.META]: 'https://api.meta.ai/v1',
  [ModelProvider.COPILOT]: null,
  [ModelProvider.OTHERS]: null,
};

interface RouteEndpoint {
  readonly baseUrl: string;
  readonly usageRoute?: UsageRoute;
}

export function resolveRouteEndpoint(
  stores: SettingsStores,
  config: Pick<ModelConfig, 'name' | 'provider' | 'baseUrl'>,
  useOpenRouter: boolean,
  declinedRoutes?: readonly DeclinableUsageRoute[],
) {
  return Effect.gen(function* () {
    if (config.provider === ModelProvider.GLM) {
      const route = yield* resolveGlmRoute({
        stores,
        baseUrl: config.baseUrl,
        useOpenRouter,
        declinedRoutes,
      });
      return route.route === 'official-coding-plan'
        ? { baseUrl: route.baseUrl, usageRoute: route.usageRoute }
        : { baseUrl: route.baseUrl };
    }
    if (config.baseUrl) return { baseUrl: config.baseUrl };
    if (useOpenRouter) return { baseUrl: OPENROUTER_BASE_URL };
    const customUrl = yield* getProviderEndpoint(stores, config.provider);
    if (customUrl) {
      return { baseUrl: `https://${normalizeProviderEndpoint(customUrl)}` };
    }
    const baseUrl = BASE_URLS[config.provider];
    const resolved =
      typeof baseUrl === 'function' ? yield* baseUrl(stores) : baseUrl;
    if (resolved === null) {
      throw new Error(
        `Model ${config.name} has no HTTP endpoint for provider ${config.provider}.`,
      );
    }
    return { baseUrl: resolved };
  });
}
