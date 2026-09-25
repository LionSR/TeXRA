import { z } from 'zod';

import {
  MODEL_PROVIDER_PLUGINS,
  findModelProviderPlugin,
  type ApiKeyProviderId,
} from '@shared/constants/modelProviderPlugins';

/** OpenAI-compatible base URL for the Kimi Code (Moonshot coding-subscription)
 *  coding endpoint. Lives here (shared) so both the model routing layer and the
 *  error-detection layer can reference it without a `common → model` edge. */
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

// ============================================================================
// Derived from the model provider plugin manifest
// ============================================================================

/** Model sources shown in selection lists, in display order. */
export const MODEL_SOURCE_ORDER: readonly string[] =
  MODEL_PROVIDER_PLUGINS.flatMap((plugin) =>
    plugin.modelSource ? [plugin.id] : [],
  );

/** Consolidated provider display names used across settings UI and model selection. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> =
  Object.fromEntries(
    MODEL_PROVIDER_PLUGINS.map((plugin) => [plugin.id, plugin.displayName]),
  );

/**
 * Display name for a provider id, falling back to the id itself when the id is
 * unknown. The single home of the `PROVIDER_DISPLAY_NAMES[id] ?? id` fallback
 * that call sites used to inline.
 */
export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

/** URLs for obtaining API keys from each provider. */
export const PROVIDER_URLS: Record<string, string> = Object.fromEntries(
  MODEL_PROVIDER_PLUGINS.flatMap((plugin) =>
    plugin.keyUrl ? [[plugin.id, plugin.keyUrl]] : [],
  ),
);

/** The providers with a custom-endpoint setting, and that setting's key. */
export const PROVIDER_ENDPOINT_STATE_ENTRIES = MODEL_PROVIDER_PLUGINS.flatMap(
  ({ id, displayName, endpointKey }) =>
    endpointKey === undefined ? [] : [{ id, displayName, endpointKey }],
);

/**
 * Default model used for auxiliary/helper tasks (polishing, agent creation,
 * merge, session descriptions). DeepSeek V4.1 Flash is the cheapest capable
 * option (~$0.15/$0.60 per MTok) and keeps these one-shot, non-streaming
 * helper calls fast.
 */
export const DEFAULT_HELPER_MODEL = 'deepseek41';

/**
 * Default model used when a new agent run / proposal omits one. Single source of
 * truth shared by the agent config schema (`@agent/core/definition/AgentConfig`),
 * the main-view persisted state, and the progress-view proposal reconstruction —
 * so a change here propagates to all three instead of drifting per call site.
 * `DEFAULT_MODELS` leads with this model, so it must not be a Gemini id.
 */
export const DEFAULT_AGENT_MODEL = 'gpt6-';

/**
 * Zod schema for one provider control rendered in the Models tab (without its
 * runtime value). The rows themselves are catalog rows — `stateSettings.ts`
 * `surfaces.models` — so this is purely the wire shape the backend projects
 * onto; `ProviderSettingSchema` in profileViewMessages.ts extends it with the
 * current `value`.
 */
export const ProviderSettingDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  warning: z.string().optional(),
  warningUrl: z.string().optional(),
  warningUrlLabel: z.string().optional(),
});

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

// ============================================================================
// Model pricing hints
// ============================================================================

/**
 * Price-based predicate for "fast first response" models.
 *
 * Models strictly under $1/M input are treated as small, fast, cheap variants
 * that are a reasonable first try. Using pricing as the single source of truth
 * avoids the substring-match foot-guns that plagued earlier regex-based versions
 * (matching `gemini*`, `minimax*`, etc. unintentionally).
 *
 * Note: capable mid-range models (e.g. Sonnet at $3/M) are deliberately not
 * "fast" in this latency sense despite moderate pricing.
 */

/** Input-price ceiling (USD per million tokens) for the fast-model hint. */
const FAST_FIRST_RESPONSE_PRICE_CEILING = 1;

/** Hint string prepended to the model tooltip when the model qualifies. */
export const FAST_FIRST_RESPONSE_HINT =
  '⚡ Fast first response — try this for quick replies';

/**
 * Returns true when a model's input price qualifies it as a fast first-try pick.
 * Undefined prices (unpriced / local / custom) are treated as non-fast.
 */
export function isFastFirstResponseModel(
  inputPrice: number | undefined,
): boolean {
  return (
    inputPrice !== undefined && inputPrice < FAST_FIRST_RESPONSE_PRICE_CEILING
  );
}

/**
 * Predicate and copy for models whose API pricing is high enough that we
 * actively steer users toward the External Inquiry tool — which lets agents
 * ask the user to paste an answer from their own ChatGPT/Claude/Gemini
 * subscription instead of paying per-token API rates.
 *
 * The test is the output price, not the name: `gpt<digits>pro` once meant
 * "Pro tier", but `gpt56pro` ships at $4/$20 while `o1pro` ($150/$600) and
 * `o3pro` ($20/$80) never matched. The Pro tier (o3pro, gpt5pro … gpt55pro,
 * o1pro) plus gpt45 all price output at $80+ per 1M; the most expensive
 * flagship tier (Opus 4/4.1) tops out at $75, so $80 separates the two.
 */

/** Output-price floor (USD per million tokens) for the premium-pricing hint. */
const EXPENSIVE_OUTPUT_PRICE_FLOOR = 80;

/** Hint string prepended to the model tooltip when the model qualifies. */
export const EXPENSIVE_MODEL_HINT =
  '💸 Premium API pricing — consider the External Inquiry tool to use your own ChatGPT/Claude subscription instead';

/**
 * Returns true when API use of the model is expensive enough to warn about.
 * Undefined prices (unpriced / local / custom) are treated as not expensive.
 */
export function isExpensiveModel(outputPrice: number | undefined): boolean {
  return (
    outputPrice !== undefined && outputPrice >= EXPENSIVE_OUTPUT_PRICE_FLOOR
  );
}
