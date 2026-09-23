import { Effect } from 'effect';
/**
 * The endpoint of one model route, resolved as an explicit URL, and the one
 * owner of endpoint precedence. The package binds a model to a stated
 * deployment endpoint (it never falls back to an SDK default), so the
 * providers the handler left to their SDKs are named here. Precedence: a
 * per-model base URL, then OpenRouter, then a per-provider dashboard
 * endpoint, then the provider default. GLM's default is its region host, on
 * the Coding Plan path when that plan serves the request, which is the one
 * place `usageRoute` is set.
 */
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import type { StateReadFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { DeclinableUsageRoute, UsageRoute } from '@shared/schemas';
import {
  getGLMCodingPlan,
  getProviderEndpoint,
  useChinaRegion,
} from '@utils/config/providerConfig';
import { tryParseUrl } from '@utils/core';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Normalize a URL-like endpoint to `host/path` form without protocol or trailing slashes. */
function normalizeProviderEndpoint(input: string): string {
  if (!input) return '';

  const withProtocol = input.includes('://') ? input : `https://${input}`;
  const parsed = tryParseUrl(withProtocol);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

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
  // Resolved by the GLM tail of `resolveRouteEndpoint`, which carries the
  // usage classification.
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
): Effect.Effect<RouteEndpoint, StateReadFailed> {
  return Effect.gen(function* () {
    if (config.baseUrl) return { baseUrl: config.baseUrl };
    if (useOpenRouter) return { baseUrl: OPENROUTER_BASE_URL };
    const customUrl = yield* getProviderEndpoint(stores, config.provider);
    if (customUrl) {
      return { baseUrl: `https://${normalizeProviderEndpoint(customUrl)}` };
    }
    if (config.provider === ModelProvider.GLM) {
      const host = (yield* useChinaRegion(stores, 'glm'))
        ? 'open.bigmodel.cn'
        : 'api.z.ai';
      // A run that declined the plan takes the standard API even while the
      // user's preference is on.
      if (
        (yield* getGLMCodingPlan(stores)) &&
        !declinedRoutes?.includes('glm-coding-plan-subscription')
      ) {
        return {
          baseUrl: `https://${host}/api/coding/paas/v4`,
          usageRoute: 'glm-coding-plan-subscription',
        };
      }
      return { baseUrl: `https://${host}/api/paas/v4` };
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
