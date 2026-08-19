import { z } from 'zod';

import { ModelProvider } from 'llm-zoo';

import { GlobalStateKey } from '@shared/state/stateKeys';

/** OpenAI-compatible base URL for the Kimi Code (Moonshot coding-subscription)
 *  coding endpoint. Lives here (shared) so both the model routing layer and the
 *  error-detection layer can reference it without a `common → model` edge. */
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

// ============================================================================
// Provider Registry — single source of truth for all provider metadata
// ============================================================================

/** Definition for a provider entry in the registry. */
interface ProviderDef {
  readonly id: ModelProvider;
  readonly displayName: string;
  /** URL for obtaining API keys. undefined = no standalone key page. */
  readonly keyUrl?: string;
  /** Global-state key for this provider's streaming toggle. */
  readonly streamingKey?: GlobalStateKey;
  /** Global-state key for this provider's custom endpoint. */
  readonly endpointKey?: GlobalStateKey;
  /** Optional alternate-region metadata for endpoint/key-url derivation. */
  readonly region?: ProviderRegionSetting;
}

interface ProviderRegionSetting {
  readonly key: GlobalStateKey;
  readonly default: boolean;
  readonly displayName?: string;
  readonly keyUrlWhenSet?: string;
  readonly keyUrlWhenUnset?: string;
}

export interface ProviderStateEntry {
  readonly id: string;
  readonly displayName: string;
  readonly streamingKey?: GlobalStateKey;
  readonly endpointKey?: GlobalStateKey;
  readonly region?: ProviderRegionSetting;
}

export type ProviderEndpointStateEntry = ProviderStateEntry & {
  readonly endpointKey: GlobalStateKey;
};

/**
 * Canonical provider registry. Registry-derived lists (MODEL_SOURCE_ORDER,
 * PROVIDER_DISPLAY_NAMES, PROVIDER_URLS, API_KEY_PROVIDER_IDS) are derived
 * from this — no manual sync needed.
 * Order here determines display order for direct model providers.
 *
 * To add a new provider that has a ModelProvider enum value: add a single entry
 * here, and it automatically flows into every derived list plus the API-key
 * provider set. Providers without a ModelProvider enum value (e.g. OpenRouter,
 * Kimi Code) live in EXTRA_API_KEY_PROVIDER_IDS instead.
 *
 */
const PROVIDER_REGISTRY = [
  {
    id: ModelProvider.OPENAI,
    displayName: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    streamingKey: GlobalStateKey.STREAMING_OPENAI,
    endpointKey: GlobalStateKey.ENDPOINT_OPENAI,
  },
  {
    id: ModelProvider.ANTHROPIC,
    displayName: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/',
    streamingKey: GlobalStateKey.STREAMING_ANTHROPIC,
    endpointKey: GlobalStateKey.ENDPOINT_ANTHROPIC,
  },
  {
    id: ModelProvider.GOOGLE,
    displayName: 'Google',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    streamingKey: GlobalStateKey.STREAMING_GOOGLE,
    endpointKey: GlobalStateKey.ENDPOINT_GOOGLE,
  },
  {
    id: ModelProvider.XAI,
    displayName: 'xAI',
    keyUrl: 'https://console.x.ai/',
    streamingKey: GlobalStateKey.STREAMING_XAI,
    endpointKey: GlobalStateKey.ENDPOINT_XAI,
  },
  {
    id: ModelProvider.DEEPSEEK,
    displayName: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    streamingKey: GlobalStateKey.STREAMING_DEEPSEEK,
    endpointKey: GlobalStateKey.ENDPOINT_DEEPSEEK,
  },
  {
    id: ModelProvider.MOONSHOT,
    displayName: 'Moonshot',
    keyUrl: 'https://platform.moonshot.cn/console',
    streamingKey: GlobalStateKey.STREAMING_MOONSHOT,
    endpointKey: GlobalStateKey.ENDPOINT_MOONSHOT,
    // China=true is the default since moonshot.cn is the primary platform;
    // when toggled off (international), keys come from platform.moonshot.ai.
    // Keys are platform-specific — a .cn key does not work on .ai.
    region: {
      key: GlobalStateKey.MOONSHOT_USE_CHINA,
      default: true,
      keyUrlWhenUnset: 'https://platform.moonshot.ai/console',
    },
  },
  {
    id: ModelProvider.DASHSCOPE,
    displayName: 'Qwen',
    keyUrl: 'https://dashscope.aliyun.com/api-console/',
    streamingKey: GlobalStateKey.STREAMING_DASHSCOPE,
    endpointKey: GlobalStateKey.ENDPOINT_DASHSCOPE,
    region: {
      key: GlobalStateKey.DASHSCOPE_USE_CHINA,
      default: false,
      displayName: 'Bailian',
      keyUrlWhenSet: 'https://bailian.console.aliyun.com/',
    },
  },
  {
    id: ModelProvider.MINIMAX,
    displayName: 'MiniMax',
    keyUrl: 'https://platform.minimax.io/',
    streamingKey: GlobalStateKey.STREAMING_MINIMAX,
    endpointKey: GlobalStateKey.ENDPOINT_MINIMAX,
    region: {
      key: GlobalStateKey.MINIMAX_USE_CHINA,
      default: false,
      keyUrlWhenSet: 'https://platform.minimaxi.com/',
    },
  },
  {
    id: ModelProvider.GLM,
    displayName: 'GLM',
    keyUrl: 'https://open.bigmodel.cn/',
    streamingKey: GlobalStateKey.STREAMING_GLM,
    endpointKey: GlobalStateKey.ENDPOINT_GLM,
    // China=true is the default since bigmodel.cn is the primary platform;
    // when toggled off (international), the key URL is z.ai.
    region: {
      key: GlobalStateKey.GLM_USE_CHINA,
      default: true,
      keyUrlWhenUnset: 'https://z.ai/',
    },
  },
  {
    id: ModelProvider.META,
    displayName: 'Meta',
    keyUrl: 'https://dev.meta.ai/',
    streamingKey: GlobalStateKey.STREAMING_META,
    endpointKey: GlobalStateKey.ENDPOINT_META,
  },
] as const satisfies readonly ProviderDef[];

/**
 * Direct API-key provider ids that have no ModelProvider enum counterpart and
 * therefore cannot live in PROVIDER_REGISTRY. Single home for these ids;
 * API_KEY_PROVIDER_IDS composes them with the registry so a new provider is
 * added in exactly one place.
 */
const EXTRA_API_KEY_PROVIDER_IDS = ['openRouter', 'kimiCode'] as const;

/** Providers not in the main registry (no server-side keys, no model selection). */
const EXTRA_DISPLAY_NAMES: Record<string, string> = {
  openRouter: 'OpenRouter',
  kimiCode: 'Kimi Code',
  [ModelProvider.COPILOT]: 'Copilot',
  [ModelProvider.OTHERS]: 'Others',
};

// ============================================================================
// Derived lists — keep in sync automatically
// ============================================================================

/** Model sources shown in selection lists. Keyless sources stay outside the API-key registry. */
export const MODEL_SOURCE_ORDER = [
  ...PROVIDER_REGISTRY.map((provider) => provider.id),
  'kimiCode',
  ModelProvider.COPILOT,
] as const;

/** Consolidated provider display names used across settings UI and model selection. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ...Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, p.displayName])),
  ...EXTRA_DISPLAY_NAMES,
};

/**
 * Display name for a provider id, falling back to the id itself when the id is
 * unknown. The single home of the `PROVIDER_DISPLAY_NAMES[id] ?? id` fallback
 * that call sites used to inline.
 */
export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

/** URLs for obtaining API keys from each provider. */
export const PROVIDER_URLS: Record<string, string> = {
  ...Object.fromEntries(
    PROVIDER_REGISTRY.flatMap((p) => (p.keyUrl ? [[p.id, p.keyUrl]] : [])),
  ),
  openRouter: 'https://openrouter.ai/keys',
  kimiCode: 'https://www.kimi.com/code/console',
};

export const PROVIDER_STATE_ENTRIES: readonly ProviderStateEntry[] = [
  ...PROVIDER_REGISTRY.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    streamingKey: provider.streamingKey,
    endpointKey: provider.endpointKey,
    region: 'region' in provider ? provider.region : undefined,
  })),
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    streamingKey: GlobalStateKey.STREAMING_OPENROUTER,
  },
  {
    id: 'kimiCode',
    displayName: 'Kimi Code',
    streamingKey: GlobalStateKey.STREAMING_KIMI_CODE,
  },
];

function hasEndpoint(
  entry: ProviderStateEntry,
): entry is ProviderEndpointStateEntry {
  return entry.endpointKey !== undefined;
}

export const PROVIDER_ENDPOINT_STATE_ENTRIES: readonly ProviderEndpointStateEntry[] =
  PROVIDER_STATE_ENTRIES.filter(hasEndpoint);

/**
 * Default model used for auxiliary/helper tasks (polishing, agent creation,
 * merge, session descriptions). DeepSeek V4 Flash is the cheapest capable
 * option (~$0.14/$0.28 per MTok) and keeps these one-shot, non-streaming
 * helper calls fast.
 */
export const DEFAULT_HELPER_MODEL = 'deepseek';

/**
 * Default model used when a new agent run / proposal omits one. Single source of
 * truth shared by the agent config schema (`@agent/core/definition/AgentConfig`),
 * the main-view persisted state, and the progress-view proposal reconstruction —
 * so a change here propagates to all three instead of drifting per call site.
 * Keep this aligned with the first default-list entry — the picker leads
 * with that model, and it must not be a Gemini id.
 */
export const DEFAULT_AGENT_MODEL = 'sonnet5T';

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
 * for direct key-provider enumeration, derived from PROVIDER_REGISTRY (plus
 * EXTRA_API_KEY_PROVIDER_IDS for the two non-enum providers). Order = display
 * order in the settings key rows; a registry addition flows in automatically.
 */
export const API_KEY_PROVIDER_IDS = Object.freeze([
  // `as const` on the registry objects keeps `provider.id` as its enum-member
  // type; the template-literal cast recovers the string value so the derived
  // tuple's element type stays a string-literal union (like the hand-written
  // list it replaces) and callers can pass plain 'anthropic'-style strings.
  ...PROVIDER_REGISTRY.map(
    (provider) => provider.id as `${typeof provider.id}`,
  ),
  ...EXTRA_API_KEY_PROVIDER_IDS,
] as const);

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
 * subscription instead of paying per-token API rates. For OpenAI's "-pro"
 * variants ($15-$30 input, $120-$180 output per 1M) a single agentic turn
 * can cost tens of dollars.
 *
 * The match is name-shaped (`gpt<digits>pro`) rather than price-thresholded
 * so a future flagship Pro release stays covered without a tweak, and other
 * vendors' priciest reasoning models aren't lumped in.
 */

/** Hint string prepended to the model tooltip when the model qualifies. */
export const EXPENSIVE_MODEL_HINT =
  '💸 Premium API pricing — consider the External Inquiry tool to use your own ChatGPT/Claude subscription instead';

const GPT_PRO_NAME = /^gpt\d+pro$/;

/** Returns true when API use of the model is expensive enough to warn about. */
export function isExpensiveModel(provider: string, name: string): boolean {
  return provider === 'openai' && GPT_PRO_NAME.test(name);
}
