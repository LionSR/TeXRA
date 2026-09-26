import { Effect } from 'effect';
/**
 * The endpoint of one model route, resolved as an explicit URL, and the one
 * owner of endpoint precedence. The package binds a model to a stated
 * deployment endpoint (it never falls back to an SDK default), so the
 * providers the handler left to their SDKs are named here. Precedence: a
 * per-model base URL, then the route's own (Kimi Code, OpenRouter), then a
 * per-provider dashboard endpoint, then the provider plugin's default
 * (`baseUrl` in `@shared/constants/modelProviderPlugins`), picked by region
 * when it has two. GLM takes its Coding Plan path when the route decided the
 * plan pays (`@model/modelRoute`).
 */

import type { StateReadFailed } from '@platform/interfaces';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
import { findModelProviderPlugin } from '@shared/constants/modelProviderPlugins';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  getProviderEndpoint,
  useChinaRegion,
} from '@utils/config/providerConfig';
import type { ModelConfig } from 'llm-zoo';

import type { ModelRoute } from './modelRoute';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Normalize a URL-like endpoint to `host/path` form without protocol or trailing slashes. */
function normalizeProviderEndpoint(input: string): string {
  if (!input) return '';

  const withProtocol = input.includes('://') ? input : `https://${input}`;
  const parsed = URL.parse(withProtocol);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

/** The GLM Coding Plan endpoint, by region. */
const GLM_CODING_PLAN_BASE_URLS = {
  china: 'https://open.bigmodel.cn/api/coding/paas/v4',
  international: 'https://api.z.ai/api/coding/paas/v4',
} as const;

export function resolveRouteEndpoint(
  stores: SettingsStores,
  config: Pick<ModelConfig, 'name' | 'provider' | 'baseUrl'>,
  route: Extract<ModelRoute, { kind: 'openrouter' | 'api-key' }>,
): Effect.Effect<string, StateReadFailed> {
  return Effect.gen(function* () {
    if (config.baseUrl) return config.baseUrl;
    if (route.kind === 'openrouter') return OPENROUTER_BASE_URL;
    if (route.usageRoute === 'kimi-code-subscription')
      return KIMI_CODE_BASE_URL;
    const customUrl = yield* getProviderEndpoint(stores, config.provider);
    if (customUrl) return `https://${normalizeProviderEndpoint(customUrl)}`;
    const baseUrl = findModelProviderPlugin(config.provider)?.baseUrl;
    if (baseUrl == null) {
      return yield* Effect.die(
        new Error(
          `Model ${config.name} has no HTTP endpoint for provider ${config.provider}.`,
        ),
      );
    }
    if (typeof baseUrl === 'string') return baseUrl;
    const region = (yield* useChinaRegion(stores, config.provider))
      ? 'china'
      : 'international';
    return route.usageRoute === 'glm-coding-plan-subscription'
      ? GLM_CODING_PLAN_BASE_URLS[region]
      : baseUrl[region];
  });
}
