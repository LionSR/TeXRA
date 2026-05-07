import { z } from 'zod';

import { ModelProvider } from 'llm-zoo';

import { GlobalStateKey } from '@common/state/stateKeys';

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
}

/**
 * Canonical provider registry. All provider lists are derived from this.
 * Order here determines display order in MODEL_PROVIDERS_ORDER.
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
  },
  {
    id: ModelProvider.ANTHROPIC,
    displayName: 'Anthropic',
    hasServerKey: true,
    keyUrl: 'https://console.anthropic.com/',
  },
  {
    id: ModelProvider.GOOGLE,
    displayName: 'Google',
    hasServerKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: ModelProvider.XAI,
    displayName: 'xAI',
    hasServerKey: true,
    keyUrl: 'https://console.x.ai/',
  },
  {
    id: ModelProvider.DEEPSEEK,
    displayName: 'DeepSeek',
    hasServerKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: ModelProvider.MOONSHOT,
    displayName: 'Moonshot',
    hasServerKey: true,
    keyUrl: 'https://platform.moonshot.cn/console',
  },
  {
    id: ModelProvider.DASHSCOPE,
    displayName: 'Qwen',
    hasServerKey: true,
    keyUrl: 'https://dashscope.aliyun.com/api-console/',
  },
  {
    id: ModelProvider.MINIMAX,
    displayName: 'MiniMax',
    hasServerKey: true,
    keyUrl: 'https://platform.minimax.io/',
  },
  {
    id: ModelProvider.GLM,
    displayName: 'GLM',
    hasServerKey: true,
    keyUrl: 'https://open.bigmodel.cn/',
  },
] as const satisfies readonly ProviderDef[];

/** Providers not in the main registry (no server-side keys, no model selection). */
const EXTRA_DISPLAY_NAMES: Record<string, string> = {
  openRouter: 'OpenRouter',
  [ModelProvider.COPILOT]: 'Copilot',
  [ModelProvider.OTHERS]: 'Others',
};

// ============================================================================
// Derived lists — keep in sync automatically
// ============================================================================

/** Providers shown in the model selection list (display order). */
export const MODEL_PROVIDERS_ORDER: ModelProvider[] = PROVIDER_REGISTRY.map(
  (p) => p.id,
);

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
};

/** Default model used for auxiliary/helper tasks (polishing, agent creation, merge, session descriptions). */
export const DEFAULT_HELPER_MODEL = 'sonnet46';

/**
 * Zod schema for a VS Code boolean setting surfaced per provider (without runtime value).
 * This is the single source of truth — ProviderVscodeSettingSchema in
 * profileViewMessages.ts extends this with a `value` field for runtime state.
 */
export const ProviderVscodeSettingDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
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
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background Responses',
      description:
        'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
    },
    {
      key: 'texra.model.openaiParallelToolCalls',
      label: 'Parallel Tool Calls',
      description:
        'Allow the model to call multiple tools in parallel. Off by default to preserve sequential tool execution.',
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
  openrouter: [
    {
      key: GlobalStateKey.USE_OPENROUTER,
      label: 'Use OpenRouter for All Models',
      description:
        'Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key. Note: OpenRouter bypasses Included Access — your OpenRouter key is always used directly.',
      globalStateKey: GlobalStateKey.USE_OPENROUTER,
    },
  ],
};
