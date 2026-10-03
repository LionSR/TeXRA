/**
 * The endpoint of one model route, resolved as an explicit URL, and the one
 * owner of endpoint precedence. The package binds a model to a stated
 * deployment endpoint (it never falls back to an SDK default), so the
 * providers the handler left to their SDKs are named here. Precedence: a
 * per-model base URL, then the route's own (Kimi Code, OpenRouter), then the
 * host's endpoint for the provider (`RouteFacts.endpoints`: a dashboard URL,
 * or the default of the region its toggle picks), then the provider plugin's
 * default (`baseUrl` in `../providers/providerPlugins.ts`). A GLM Coding Plan
 * key takes its region's Responses endpoint, the same one an API key does.
 */

import { findModelProviderPlugin } from '../providers/providerPlugins.js';
import { KIMI_CODE_BASE_URL } from '../providers/providers.js';
import type { ModelConfig } from 'llm-zoo';
import type { ModelRoute, RouteFacts } from './modelRoute.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The endpoint `route` sends `config`'s requests to, or `undefined` when no
 * endpoint is stated for the provider (a regional provider the host gave no
 * endpoint).
 */
export function resolveRouteEndpoint(
  config: Pick<ModelConfig, 'provider' | 'baseUrl'>,
  route: Extract<ModelRoute, { kind: 'openrouter' | 'api-key' }>,
  facts: Pick<RouteFacts, 'endpoints'>,
): string | undefined {
  if (config.baseUrl) return config.baseUrl;
  if (route.kind === 'openrouter') return OPENROUTER_BASE_URL;
  if (route.usageRoute === 'kimi-code-subscription') return KIMI_CODE_BASE_URL;
  const hostUrl = facts.endpoints[config.provider];
  if (hostUrl) return hostUrl;
  const baseUrl = findModelProviderPlugin(config.provider)?.baseUrl;
  return typeof baseUrl === 'string' ? baseUrl : undefined;
}
