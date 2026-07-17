import { z } from 'zod';

import { ModelProvider } from 'llm-zoo';

import { GlobalStateKey } from '@shared/state/stateKeys';

// ============================================================================
// Provider Registry — single source of truth for all provider metadata
// ============================================================================

/** Definition for a provider entry in the registry. */
interface ProviderDef {
  readonly id: ModelProvider;
  readonly displayName: string;
  /** Whether this provider supports server-side (relay) API keys. */
  readonly hasServerKey: boolean;
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
 * Canonical provider registry. All provider lists are derived from this.
 * Order here determines display order for direct model providers.
 *
 * To add a new provider: add a single entry here.
 * hasServerKey: true → automatically included in SERVER_SIDE_PROVIDERS.
 */
const PROVIDER_REGISTRY = [
  {
    id: ModelProvider.OPENAI,
    displayName: 'OpenAI',
    hasServerKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    streamingKey: GlobalStateKey.STREAMING_OPENAI,
    endpointKey: GlobalStateKey.ENDPOINT_OPENAI,
  },
  {
    id: ModelProvider.ANTHROPIC,
    displayName: 'Anthropic',
    hasServerKey: true,
    keyUrl: 'https://console.anthropic.com/',
    streamingKey: GlobalStateKey.STREAMING_ANTHROPIC,
    endpointKey: GlobalStateKey.ENDPOINT_ANTHROPIC,
  },
  {
    id: ModelProvider.GOOGLE,
    displayName: 'Google',
    hasServerKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    streamingKey: GlobalStateKey.STREAMING_GOOGLE,
    endpointKey: GlobalStateKey.ENDPOINT_GOOGLE,
  },
  {
    id: ModelProvider.XAI,
    displayName: 'xAI',
    hasServerKey: true,
    keyUrl: 'https://console.x.ai/',
    streamingKey: GlobalStateKey.STREAMING_XAI,
    endpointKey: GlobalStateKey.ENDPOINT_XAI,
  },
  {
    id: ModelProvider.DEEPSEEK,
    displayName: 'DeepSeek',
    hasServerKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    streamingKey: GlobalStateKey.STREAMING_DEEPSEEK,
    endpointKey: GlobalStateKey.ENDPOINT_DEEPSEEK,
  },
  {
    id: ModelProvider.MOONSHOT,
    displayName: 'Moonshot',
    hasServerKey: true,
    keyUrl: 'https://platform.moonshot.cn/console',
    streamingKey: GlobalStateKey.STREAMING_MOONSHOT,
    endpointKey: GlobalStateKey.ENDPOINT_MOONSHOT,
  },
  {
    id: ModelProvider.DASHSCOPE,
    displayName: 'Qwen',
    hasServerKey: true,
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
    hasServerKey: true,
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
    hasServerKey: true,
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
    // The supabase relay does not forward to Meta yet (see
    // supabase/functions/relay/models.ts ALL_PROVIDERS) — flip this together
    // with the relay-side provider registration when Included Access lands.
    hasServerKey: false,
    keyUrl: 'https://dev.meta.ai/',
    streamingKey: GlobalStateKey.STREAMING_META,
    endpointKey: GlobalStateKey.ENDPOINT_META,
  },
] as const satisfies readonly ProviderDef[];

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
export const MODEL_SOURCE_ORDER: ModelProvider[] = [
  ...PROVIDER_REGISTRY.map((provider) => provider.id),
  ModelProvider.COPILOT,
];

/**
 * All providers that support server-side API keys.
 * Derived from PROVIDER_REGISTRY — no manual sync needed.
 *
 * Note: We use a type-level extraction so ServerSideProvider is a proper
 * union of literal ModelProvider values, not just `ModelProvider`.
 */
type ServerKeyEntry = Extract<
  (typeof PROVIDER_REGISTRY)[number],
  { hasServerKey: true }
>;
export const SERVER_SIDE_PROVIDER_IDS: readonly ServerKeyEntry['id'][] =
  PROVIDER_REGISTRY.filter((p) => p.hasServerKey).map((p) => p.id);

/** Type for providers that support server-side keys (narrow union, not just ModelProvider). */
export type ServerSideProvider = ServerKeyEntry['id'];

/** Consolidated provider display names used across settings UI and model selection. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ...Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, p.displayName])),
  ...EXTRA_DISPLAY_NAMES,
};

/** URLs for obtaining API keys from each provider. */
export const PROVIDER_URLS: Record<string, string> = {
  ...Object.fromEntries(
    PROVIDER_REGISTRY.flatMap((p) => (p.keyUrl ? [[p.id, p.keyUrl]] : [])),
  ),
  openRouter: 'https://openrouter.ai/keys',
  kimiCode: 'https://code.kimi.com/',
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
 */
export const DEFAULT_AGENT_MODEL = 'gemini35f';

/**
 * Zod schema for a VS Code boolean setting surfaced per provider (without runtime value).
 * This is the single source of truth — ProviderVscodeSettingSchema in
 * profileViewMessages.ts extends this with a `value` field for runtime state.
 */
export const ProviderVscodeSettingDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  defaultValue: z.boolean().optional(),
  warning: z.string().optional(),
  warningUrl: z.string().optional(),
  warningUrlLabel: z.string().optional(),
  /**
   * When set, the setting is backed by globalSM (extension global state)
   * instead of VS Code's workspace configuration.
   */
  globalStateKey: z.string().optional(),
});

export type ProviderVscodeSettingDef = z.infer<
  typeof ProviderVscodeSettingDefSchema
>;

export const USE_OPENROUTER_PROVIDER_SETTING = {
  key: GlobalStateKey.USE_OPENROUTER,
  label: 'Use OpenRouter for All Models',
  description:
    'Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key. Note: OpenRouter bypasses Included Access — your OpenRouter key is always used directly.',
  globalStateKey: GlobalStateKey.USE_OPENROUTER,
} satisfies ProviderVscodeSettingDef;

/** VS Code config settings to surface per provider in the Models tab. */
export const PROVIDER_VSCODE_SETTINGS: Record<
  string,
  ProviderVscodeSettingDef[]
> = {
  openai: [
    {
      key: 'texra.model.gpt5ReasoningSummary',
      label: 'GPT-5 Reasoning Summary',
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
      label: 'Use Responses API',
      description:
        'Use the OpenAI Responses API instead of Chat Completions when available.',
      defaultValue: true,
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background Responses',
      description:
        'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
      defaultValue: true,
    },
    {
      key: 'texra.model.openaiParallelToolCalls',
      label: 'Parallel Tool Calls',
      description:
        'Allow the model to call multiple tools in parallel. On by default; disable for models that require sequential execution.',
      defaultValue: true,
    },
    {
      key: GlobalStateKey.WEBSOCKET_OPENAI,
      label: 'WebSocket Transport',
      description:
        'Use a persistent WebSocket connection for lower-latency tool-use loops. Requires direct OpenAI API (not compatible with custom endpoints).',
      globalStateKey: GlobalStateKey.WEBSOCKET_OPENAI,
    },
  ],
  anthropic: [],
  google: [
    {
      key: 'texra.model.useGoogleInteractionsAPI',
      label: 'Use Interactions API',
      description:
        'Use the Google Interactions API instead of Generate Content when available.',
      defaultValue: true,
    },
    {
      key: 'texra.model.useGoogleInteractionsServerState',
      label: 'Server-side conversation state',
      description:
        "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round.",
      defaultValue: true,
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background Responses',
      description:
        'Run long-running workflow generations as background Interactions (submit + poll) to avoid timeouts. Requires server-side conversation state; models that do not support it fall back automatically.',
      defaultValue: true,
    },
  ],
  dashscope: [
    {
      key: GlobalStateKey.DASHSCOPE_USE_CHINA,
      label: 'China Region (Bailian)',
      description:
        'Use the China region endpoint (dashscope.aliyuncs.com) instead of international (dashscope-intl.aliyuncs.com). Display name switches to "Bailian".',
      globalStateKey: GlobalStateKey.DASHSCOPE_USE_CHINA,
    },
  ],
  minimax: [
    {
      key: GlobalStateKey.MINIMAX_USE_CHINA,
      label: 'China Region',
      description:
        'Use the China region endpoint (api.minimaxi.com) instead of international (api.minimax.io). API keys are region-specific — you must obtain a key from the matching region.',
      warning:
        'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
      warningUrl: 'https://platform.minimax.io/',
      warningUrlLabel: 'Get API key',
      globalStateKey: GlobalStateKey.MINIMAX_USE_CHINA,
    },
  ],
  glm: [
    {
      key: GlobalStateKey.GLM_USE_CHINA,
      label: 'China Region',
      description:
        'Use the China region endpoint (open.bigmodel.cn) instead of international (api.z.ai). Enabled by default. API keys work with either endpoint.',
      defaultValue: true,
      warningUrl: 'https://open.bigmodel.cn/',
      warningUrlLabel: 'BigModel console',
      globalStateKey: GlobalStateKey.GLM_USE_CHINA,
    },
    {
      key: GlobalStateKey.GLM_CODING_PLAN,
      label: 'Coding Plan',
      description:
        'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
      warningUrl: 'https://z.ai/subscribe',
      warningUrlLabel: 'Subscribe',
      globalStateKey: GlobalStateKey.GLM_CODING_PLAN,
    },
  ],
  openrouter: [USE_OPENROUTER_PROVIDER_SETTING],
};
