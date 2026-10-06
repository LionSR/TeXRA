import {
  MODEL_PROVIDER_PLUGINS,
  findModelProviderPlugin,
  type ApiKeyProviderId,
} from './providerPlugins.js';

/** OpenAI-compatible base URL for the Kimi Code (Moonshot coding-subscription)
 *  coding endpoint, which the route decision and its endpoint both name. */
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

/**
 * A provider's own name, the one people know it by, falling back to the id
 * when the id names no provider plugin.
 */
export function providerDisplayName(provider: string): string {
  return findModelProviderPlugin(provider)?.displayName ?? provider;
}

// ============================================================================
// Direct API-key providers
// ============================================================================

/**
 * Provider IDs where users can configure direct API keys — the single source
 * for direct key-provider enumeration, derived from the plugin manifest.
 * Order = display order in the settings key rows.
 */
export const API_KEY_PROVIDER_IDS: readonly ApiKeyProviderId[] = Object.freeze(
  MODEL_PROVIDER_PLUGINS.flatMap((plugin) =>
    plugin.apiKey ? [plugin.id as ApiKeyProviderId] : [],
  ),
);

/** Environment variable for a provider's API key. */
export function apiKeyEnvName(provider: ApiKeyProviderId): string {
  return (
    findModelProviderPlugin(provider)?.apiKeyEnvName ??
    `${provider.toUpperCase()}_API_KEY`
  );
}

/**
 * Every environment variable TeXRA reads as a provider API key, derived from
 * the provider manifest, so a provider added there is covered here. A child
 * process TeXRA spawns does not inherit them (see `inheritedEnv`).
 */
export const API_KEY_ENV_NAMES: readonly string[] = Object.freeze(
  API_KEY_PROVIDER_IDS.map(apiKeyEnvName),
);
