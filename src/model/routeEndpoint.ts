import { Effect } from 'effect';
/**
 * The endpoint of one model route, resolved as an explicit URL, and the one
 * owner of endpoint precedence. The package binds a model to a stated
 * deployment endpoint (it never falls back to an SDK default), so the
 * providers the handler left to their SDKs are named here. Precedence: a
 * per-model base URL, then OpenRouter, then a per-provider dashboard
 * endpoint, then the provider plugin's default (`baseUrl` in
 * `@shared/constants/modelProviderPlugins`), picked by region when it has
 * two. GLM takes its Coding Plan path when that plan serves the request,
 * which is the one place `usageRoute` is set.
 */
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import type { StateReadFailed } from '@platform/interfaces';
import { findModelProviderPlugin } from '@shared/constants/modelProviderPlugins';
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

/** The GLM Coding Plan endpoint, by region. */
const GLM_CODING_PLAN_BASE_URLS = {
  china: 'https://open.bigmodel.cn/api/coding/paas/v4',
  international: 'https://api.z.ai/api/coding/paas/v4',
} as const;

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
    const baseUrl = findModelProviderPlugin(config.provider)?.baseUrl;
    if (baseUrl == null) {
      throw new Error(
        `Model ${config.name} has no HTTP endpoint for provider ${config.provider}.`,
      );
    }
    if (typeof baseUrl === 'string') return { baseUrl };
    const region = (yield* useChinaRegion(stores, config.provider))
      ? 'china'
      : 'international';
    // A run that declined the plan takes the standard API even while the
    // user's preference is on.
    if (
      config.provider === ModelProvider.GLM &&
      (yield* getGLMCodingPlan(stores)) &&
      !declinedRoutes?.includes('glm-coding-plan-subscription')
    ) {
      return {
        baseUrl: GLM_CODING_PLAN_BASE_URLS[region],
        usageRoute: 'glm-coding-plan-subscription',
      };
    }
    return { baseUrl: baseUrl[region] };
  });
}
