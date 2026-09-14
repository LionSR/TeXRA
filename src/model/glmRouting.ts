import { ModelProvider } from 'llm-zoo';

import { OPENROUTER_BASE_URL } from '@model/openRouterEndpoint';
import { normalizeProviderEndpoint } from '@model/providerEndpoint';
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
  readonly baseUrl?: string | null;
  readonly useOpenRouter: boolean;
  /** Routes the asking run declines; a declined coding plan is not taken
   *  even while the user's preference is on. */
  readonly declinedRoutes?: readonly DeclinableUsageRoute[];
}

/** Resolve the endpoint and usage classification for one GLM request. */
export function resolveGlmRoute(config: GlmRoutingConfig): GlmRoute {
  if (config.baseUrl) {
    return { route: 'model-custom', baseUrl: config.baseUrl };
  }
  if (config.useOpenRouter) {
    return { route: 'openrouter', baseUrl: OPENROUTER_BASE_URL };
  }

  const providerEndpoint = getProviderEndpoint(ModelProvider.GLM);
  if (providerEndpoint) {
    return {
      route: 'provider-custom',
      baseUrl: `https://${normalizeProviderEndpoint(providerEndpoint)}`,
    };
  }

  const officialHost = useChinaRegion('glm') ? 'open.bigmodel.cn' : 'api.z.ai';
  if (
    getGLMCodingPlan() &&
    !config.declinedRoutes?.includes('glm-coding-plan-subscription')
  ) {
    return {
      route: 'official-coding-plan',
      baseUrl: `https://${officialHost}/api/coding/paas/v4`,
      usageRoute: 'glm-coding-plan-subscription',
    };
  }
  return {
    route: 'official',
    baseUrl: `https://${officialHost}/api/paas/v4`,
  };
}
