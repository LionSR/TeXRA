import { Effect } from 'effect';
import { ModelProvider } from 'llm-zoo';

import { OPENROUTER_BASE_URL } from '@model/openRouterEndpoint';
import { normalizeProviderEndpoint } from '@model/providerEndpoint';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { DeclinableUsageRoute } from '@shared/schemas';
import {
  getGLMCodingPlan,
  getProviderEndpoint,
  useChinaRegion,
} from '@utils/config/providerConfig';

type GlmRoute =
  | { readonly route: 'model-custom'; readonly baseUrl: string }
  | { readonly route: 'openrouter'; readonly baseUrl: string }
  | { readonly route: 'provider-custom'; readonly baseUrl: string }
  | {
      readonly route: 'official-coding-plan';
      readonly baseUrl: string;
      readonly usageRoute: 'glm-coding-plan-subscription';
    }
  | { readonly route: 'official'; readonly baseUrl: string };

interface GlmRoutingConfig {
  /** The setting slots the endpoint, region, and coding-plan rows are read from. */
  readonly stores: SettingsStores;
  readonly baseUrl?: string | null;
  readonly useOpenRouter: boolean;
  /** Routes the asking run declines; a declined coding plan is not taken
   *  even while the user's preference is on. */
  readonly declinedRoutes?: readonly DeclinableUsageRoute[];
}

/**
 * Whether a GLM request routes through OpenRouter. The two rows of
 * {@link resolveGlmRoute}'s precedence that settle before any setting is read
 * — a per-model base URL wins, then the OpenRouter selection — so the
 * store-free routing predicates in `openRouterRouting` answer this question
 * without the setting slots the rest of the table needs.
 */
export function isGlmOpenRouterRoute(config: {
  readonly baseUrl?: string | null;
  readonly useOpenRouter: boolean;
}): boolean {
  return !config.baseUrl && config.useOpenRouter;
}

/** Resolve the endpoint and usage classification for one GLM request. */
export function resolveGlmRoute(config: GlmRoutingConfig) {
  return Effect.gen(function* () {
    if (config.baseUrl) {
      return { route: 'model-custom' as const, baseUrl: config.baseUrl };
    }
    if (isGlmOpenRouterRoute(config)) {
      return { route: 'openrouter' as const, baseUrl: OPENROUTER_BASE_URL };
    }

    const providerEndpoint = yield* getProviderEndpoint(
      config.stores,
      ModelProvider.GLM,
    );
    if (providerEndpoint) {
      return {
        route: 'provider-custom' as const,
        baseUrl: `https://${normalizeProviderEndpoint(providerEndpoint)}`,
      };
    }

    const officialHost = (yield* useChinaRegion(config.stores, 'glm'))
      ? 'open.bigmodel.cn'
      : 'api.z.ai';
    if (
      (yield* getGLMCodingPlan(config.stores)) &&
      !config.declinedRoutes?.includes('glm-coding-plan-subscription')
    ) {
      return {
        route: 'official-coding-plan' as const,
        baseUrl: `https://${officialHost}/api/coding/paas/v4`,
        usageRoute: 'glm-coding-plan-subscription' as const,
      };
    }
    return {
      route: 'official' as const,
      baseUrl: `https://${officialHost}/api/paas/v4`,
    };
  });
}
