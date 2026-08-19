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
 * SERVER_SIDE_PROVIDER_IDS, PROVIDER_DISPLAY_NAMES, PROVIDER_URLS,
 * API_KEY_PROVIDER_IDS) are derived from this — no manual sync needed.
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

/** Providers not in the main registry (no model selection). */
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
 * Zod schema for a boolean setting surfaced per provider (without runtime value).
 * This is the single source of truth — ProviderSettingSchema in
 * profileViewMessages.ts extends this with a `value` field for runtime state.
 */
export const ProviderSettingDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  defaultValue: z.boolean().optional(),
  warning: z.string().optional(),
  warningUrl: z.string().optional(),
  warningUrlLabel: z.string().optional(),
  /**
   * When set, the setting is backed by shared state rather than configuration.
   */
  globalStateKey: z.string().optional(),
});

export type ProviderSettingDef = z.infer<typeof ProviderSettingDefSchema>;

export const USE_OPENROUTER_PROVIDER_SETTING = {
  key: GlobalStateKey.USE_OPENROUTER,
  label: 'Use OpenRouter for all models',
  description:
    'Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key; your OpenRouter key is always used directly.',
  globalStateKey: GlobalStateKey.USE_OPENROUTER,
} satisfies ProviderSettingDef;

// Named exports for the global-state-backed provider toggles below, so the CLI
// state-setting catalog (`stateSettings.ts`) can reuse their label/description
// by reference instead of copying strings that would drift. Anything without a
// named export here is a config-backed setting.
export const DASHSCOPE_USE_CHINA_PROVIDER_SETTING = {
  key: GlobalStateKey.DASHSCOPE_USE_CHINA,
  label: 'Qwen China region (Bailian)',
  description:
    'Use the China region endpoint (dashscope.aliyuncs.com) instead of international (dashscope-intl.aliyuncs.com). Display name switches to "Bailian".',
  globalStateKey: GlobalStateKey.DASHSCOPE_USE_CHINA,
} satisfies ProviderSettingDef;

export const MINIMAX_USE_CHINA_PROVIDER_SETTING = {
  key: GlobalStateKey.MINIMAX_USE_CHINA,
  label: 'MiniMax China region',
  description:
    'Use the China region endpoint (api.minimaxi.com) instead of international (api.minimax.io). API keys are region-specific — you must obtain a key from the matching region.',
  warning:
    'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
  warningUrl: 'https://platform.minimax.io/',
  warningUrlLabel: 'Get API key',
  globalStateKey: GlobalStateKey.MINIMAX_USE_CHINA,
} satisfies ProviderSettingDef;

export const MOONSHOT_USE_CHINA_PROVIDER_SETTING = {
  key: GlobalStateKey.MOONSHOT_USE_CHINA,
  label: 'Kimi/Moonshot China region',
  description:
    'Use the China endpoint (api.moonshot.cn) instead of international (api.moonshot.ai). Enabled by default. Keys are platform-specific — get international keys at platform.moonshot.ai.',
  defaultValue: true,
  warning:
    'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
  warningUrl: 'https://platform.moonshot.ai/console',
  warningUrlLabel: 'International console',
  globalStateKey: GlobalStateKey.MOONSHOT_USE_CHINA,
} satisfies ProviderSettingDef;

export const GLM_USE_CHINA_PROVIDER_SETTING = {
  key: GlobalStateKey.GLM_USE_CHINA,
  label: 'GLM China region',
  description:
    'Use the China region endpoint (open.bigmodel.cn) instead of international (api.z.ai). Enabled by default. API keys work with either endpoint.',
  defaultValue: true,
  warningUrl: 'https://open.bigmodel.cn/',
  warningUrlLabel: 'BigModel console',
  globalStateKey: GlobalStateKey.GLM_USE_CHINA,
} satisfies ProviderSettingDef;

export const GLM_CODING_PLAN_PROVIDER_SETTING = {
  key: GlobalStateKey.GLM_CODING_PLAN,
  label: 'GLM Coding Plan',
  description:
    'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
  warningUrl: 'https://z.ai/subscribe',
  warningUrlLabel: 'Subscribe',
  globalStateKey: GlobalStateKey.GLM_CODING_PLAN,
} satisfies ProviderSettingDef;

export const KIMI_CODE_PREFER_PROVIDER_SETTING = {
  key: GlobalStateKey.KIMI_CODE_PREFER,
  label: 'Prefer Kimi Code',
  description:
    'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
  defaultValue: false,
  globalStateKey: GlobalStateKey.KIMI_CODE_PREFER,
} satisfies ProviderSettingDef;

/** Settings surfaced per canonical provider id in the Models tab. */
export const PROVIDER_SETTINGS: Record<string, ProviderSettingDef[]> = {
  openai: [
    {
      key: 'texra.model.gpt5ReasoningSummary',
      label: 'GPT-5 reasoning summary',
      description:
        'Request reasoning summaries from GPT-5 models. Only available on OpenAI API Tier 3+.',
      warning:
        'New accounts with $20 credit are typically Tier 1 and will hit rate limits.',
      warningUrl:
        'https://platform.openai.com/settings/organization/billing/overview',
      warningUrlLabel: 'Check your tier',
    },
    {
      key: 'texra.model.useOpenAIResponsesAPI',
      label: 'Use the Responses API',
      description:
        'Use the OpenAI Responses API instead of Chat Completions when available.',
      defaultValue: true,
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background responses',
      description:
        'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
      defaultValue: true,
    },
    {
      key: 'texra.model.openaiParallelToolCalls',
      label: 'Parallel tool calls',
      description:
        'Allow the model to call multiple tools in parallel. On by default; disable for models that require sequential execution.',
      defaultValue: true,
    },
    {
      key: GlobalStateKey.WEBSOCKET_OPENAI,
      label: 'WebSocket transport',
      description:
        'Use a persistent WebSocket connection for lower-latency tool-use loops. Requires direct OpenAI API (not compatible with custom endpoints).',
      globalStateKey: GlobalStateKey.WEBSOCKET_OPENAI,
    },
  ],
  anthropic: [],
  google: [
    {
      key: 'texra.model.useGoogleInteractionsServerState',
      label: 'Server-side conversation state',
      description:
        "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round.",
      defaultValue: true,
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background responses',
      description:
        'Run long-running workflow generations as background Interactions (submit + poll) to avoid timeouts. Requires server-side conversation state; models that do not support it fall back automatically.',
      defaultValue: true,
    },
  ],
  dashscope: [DASHSCOPE_USE_CHINA_PROVIDER_SETTING],
  minimax: [MINIMAX_USE_CHINA_PROVIDER_SETTING],
  moonshot: [MOONSHOT_USE_CHINA_PROVIDER_SETTING],
  glm: [GLM_USE_CHINA_PROVIDER_SETTING, GLM_CODING_PLAN_PROVIDER_SETTING],
  kimiCode: [KIMI_CODE_PREFER_PROVIDER_SETTING],
  openRouter: [USE_OPENROUTER_PROVIDER_SETTING],
};

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
