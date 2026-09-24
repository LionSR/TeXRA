/**
 * The model provider plugin manifest — the one list every model provider
 * belongs to. Each entry is a stable id plus everything TeXRA knows about the
 * provider that is not a wire protocol: dashboard copy, the API-key page and
 * environment variable, the custom-endpoint and region settings, the default
 * HTTP endpoint, the conversation format its models bind under, and the
 * setup assistant's probe model.
 *
 * Derived from this list: the provider display names, key URLs, model-source
 * and API-key provider orders, custom-endpoint entries
 * (`@shared/constants/providers`), the endpoint and region settings
 * (`@shared/state/stateSettings`),
 * API-key env names (`@model/apiProviders`), default endpoints
 * (`@model/routeEndpoint`), provider compatibility keys
 * (`@agent/runtime/modelRoutes`) and setup models (`@model/setupModelDefaults`).
 * Wire protocols (`TurnProtocolSchema`, the `ModelCompatibilityKey` union,
 * `PROTOCOL_DESCRIPTORS`) and key redaction patterns stay core.
 *
 * Rules: an id is persisted (the `apiKey.<id>` secret, model configs,
 * settings), so it never changes and is never reused. Every llm-zoo
 * `ModelProvider` has an entry with a `compatibilityKey` (checked below). No
 * hooks, event channels or runtime registration: a plugin is data, read by
 * code at every startup. Plain data only — the settings webview imports the
 * derived lists, so nothing here may pull in a Node or Effect module.
 */

import type { ModelCompatibilityKey } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { ModelProvider } from 'llm-zoo';

/**
 * OpenAI's own endpoint. Named because a route that lands on it is the one
 * the Responses WebSocket transport is known to serve: a per-model or
 * dashboard endpoint may not speak it at all.
 */
export const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/**
 * A provider's China-region toggle — a catalog setting (`stateSettings.ts`)
 * and a Models tab control — and the copy that depends on it.
 */
interface ProviderRegionSetting {
  readonly key: GlobalStateKey;
  readonly default: boolean;
  /** The toggle's Models tab control copy (`ProviderSettingDefSchema`). */
  readonly control: {
    readonly label: string;
    readonly description: string;
    readonly warning?: string;
    readonly warningUrl?: string;
    readonly warningUrlLabel?: string;
  };
  readonly displayName?: string;
  readonly keyUrlWhenSet?: string;
  readonly keyUrlWhenUnset?: string;
}

/** A default endpoint that depends on the provider's region toggle. */
interface RegionalBaseUrl {
  readonly china: string;
  readonly international: string;
}

/** One model provider plugin. */
interface ModelProviderPlugin {
  /** Stable, persisted identifier: the llm-zoo provider or API-key id. */
  readonly id: string;
  readonly displayName: string;
  /** Page where a user obtains an API key. */
  readonly keyUrl?: string;
  /** Users can configure a direct API key for this provider. */
  readonly apiKey?: true;
  /** Environment variable for the key when it is not `<ID>_API_KEY`. */
  readonly apiKeyEnvName?: string;
  /** Global-state key for the provider's custom endpoint. */
  readonly endpointKey?: GlobalStateKey;
  /** Alternate-region toggle for endpoint and key-URL derivation. */
  readonly region?: ProviderRegionSetting;
  /**
   * Default HTTP base URL, or a China/international pair chosen by the
   * region toggle. `null`: an llm-zoo provider with no HTTP route of its
   * own (checked below, so a dropped endpoint is a compile error). Absent:
   * a plugin outside llm-zoo's `ModelProvider` (`openRouter`, `kimiCode`).
   */
  readonly baseUrl?: string | RegionalBaseUrl | null;
  /** Conversation format a direct route to this provider binds under. */
  readonly compatibilityKey?: ModelCompatibilityKey;
  /** Model the setup assistant probes when this is the only credential. */
  readonly setupModel?: string;
  /** Listed as a model source in selection lists. */
  readonly modelSource?: true;
}

/**
 * Every model provider, in display order. Setup-model pins are literal data:
 * `SetupModelDefaults.vitest.ts` fails an llm-zoo bump that retires or
 * deprecates one. The openai pin must stay Codex-eligible: it proves
 * ChatGPT-subscription access.
 */
const MANIFEST = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_OPENAI,
    baseUrl: OPENAI_DEFAULT_ENDPOINT,
    compatibilityKey: 'OpenAI',
    setupModel: 'gpt6-',
    modelSource: true,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_ANTHROPIC,
    baseUrl: 'https://api.anthropic.com',
    compatibilityKey: 'Anthropic',
    setupModel: 'opus55',
    modelSource: true,
  },
  {
    id: 'google',
    displayName: 'Google',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_GOOGLE,
    baseUrl: 'https://generativelanguage.googleapis.com',
    compatibilityKey: 'GoogleInteractions',
    setupModel: 'gemini31p',
    modelSource: true,
  },
  {
    id: 'xai',
    displayName: 'xAI',
    keyUrl: 'https://console.x.ai/',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_XAI,
    baseUrl: 'https://api.x.ai/v1',
    compatibilityKey: 'XAI',
    setupModel: 'grok47',
    modelSource: true,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_DEEPSEEK,
    baseUrl: 'https://api.deepseek.com',
    compatibilityKey: 'DeepSeek',
    setupModel: 'deepseekproT',
    modelSource: true,
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    keyUrl: 'https://platform.moonshot.cn/console',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_MOONSHOT,
    // China=true is the default since moonshot.cn is the primary platform;
    // when toggled off (international), keys come from platform.moonshot.ai.
    // Keys are platform-specific — a .cn key does not work on .ai.
    region: {
      key: GlobalStateKey.MOONSHOT_USE_CHINA,
      default: true,
      control: {
        label: 'Kimi/Moonshot China region',
        description:
          'Use the China endpoint (api.moonshot.cn) instead of international (api.moonshot.ai). Enabled by default. Keys are platform-specific — get international keys at platform.moonshot.ai.',
        warning:
          'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
        warningUrl: 'https://platform.moonshot.ai/console',
        warningUrlLabel: 'International console',
      },
      keyUrlWhenUnset: 'https://platform.moonshot.ai/console',
    },
    // Kimi Code models never reach this: their coding baseUrl wins as the
    // per-model override.
    baseUrl: {
      china: 'https://api.moonshot.cn/v1',
      international: 'https://api.moonshot.ai/v1',
    },
    compatibilityKey: 'Kimi',
    setupModel: 'kimi26T',
    modelSource: true,
  },
  {
    id: 'dashscope',
    displayName: 'Qwen',
    keyUrl: 'https://dashscope.aliyun.com/api-console/',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_DASHSCOPE,
    region: {
      key: GlobalStateKey.DASHSCOPE_USE_CHINA,
      default: false,
      control: {
        label: 'Qwen China region (Bailian)',
        description:
          'Use the China region endpoint (dashscope.aliyuncs.com) instead of international (dashscope-intl.aliyuncs.com). Display name switches to "Bailian".',
      },
      displayName: 'Bailian',
      keyUrlWhenSet: 'https://bailian.console.aliyun.com/',
    },
    baseUrl: {
      china: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
    compatibilityKey: 'DashScope',
    setupModel: 'qwenplus',
    modelSource: true,
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    keyUrl: 'https://platform.minimax.io/',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_MINIMAX,
    region: {
      key: GlobalStateKey.MINIMAX_USE_CHINA,
      default: false,
      control: {
        label: 'MiniMax China region',
        description:
          'Use the China region endpoint (api.minimaxi.com) instead of international (api.minimax.io). API keys are region-specific — you must obtain a key from the matching region.',
        warning:
          'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
        warningUrl: 'https://platform.minimax.io/',
        warningUrlLabel: 'Get API key',
      },
      keyUrlWhenSet: 'https://platform.minimaxi.com/',
    },
    // China: api.minimaxi.com (note the extra 'i').
    baseUrl: {
      china: 'https://api.minimaxi.com/v1',
      international: 'https://api.minimax.io/v1',
    },
    compatibilityKey: 'MiniMax',
    setupModel: 'minimaxM3',
    modelSource: true,
  },
  {
    id: 'glm',
    displayName: 'GLM',
    keyUrl: 'https://open.bigmodel.cn/',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_GLM,
    // China=true is the default since bigmodel.cn is the primary platform;
    // when toggled off (international), the key URL is z.ai.
    region: {
      key: GlobalStateKey.GLM_USE_CHINA,
      default: true,
      control: {
        label: 'GLM China region',
        description:
          'Use the China region endpoint (open.bigmodel.cn) instead of international (api.z.ai). Enabled by default. API keys work with either endpoint.',
        warningUrl: 'https://open.bigmodel.cn/',
        warningUrlLabel: 'BigModel console',
      },
      keyUrlWhenUnset: 'https://z.ai/',
    },
    // The standard API; `@model/routeEndpoint` owns the Coding Plan path.
    baseUrl: {
      china: 'https://open.bigmodel.cn/api/paas/v4',
      international: 'https://api.z.ai/api/paas/v4',
    },
    compatibilityKey: 'GLM',
    setupModel: 'glm53',
    modelSource: true,
  },
  {
    id: 'meta',
    displayName: 'Meta',
    keyUrl: 'https://dev.meta.ai/',
    apiKey: true,
    endpointKey: GlobalStateKey.ENDPOINT_META,
    baseUrl: 'https://api.meta.ai/v1',
    compatibilityKey: 'Meta',
    setupModel: 'musespark13',
    modelSource: true,
  },
  {
    id: 'openRouter',
    displayName: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    apiKey: true,
    setupModel: 'sonnet5T',
  },
  {
    id: 'kimiCode',
    displayName: 'Kimi Code',
    keyUrl: 'https://www.kimi.com/code/console',
    apiKey: true,
    apiKeyEnvName: 'KIMI_CODE_API_KEY',
    setupModel: 'kimiCoding',
    modelSource: true,
  },
  {
    id: 'copilot',
    displayName: 'Copilot',
    baseUrl: null,
    compatibilityKey: 'VscodeLm',
    modelSource: true,
  },
  {
    id: 'others',
    displayName: 'Others',
    baseUrl: null,
    compatibilityKey: 'OpenRouterNative',
  },
] as const satisfies readonly ModelProviderPlugin[];

/** Every model provider plugin, in display order. */
export const MODEL_PROVIDER_PLUGINS: readonly ModelProviderPlugin[] = MANIFEST;

type ModelProviderPluginEntry = (typeof MANIFEST)[number];

/** Ids of the providers users can configure a direct API key for. */
export type ApiKeyProviderId = Extract<
  ModelProviderPluginEntry,
  { readonly apiKey: true }
>['id'];

/** Look up a provider plugin by id. */
export function findModelProviderPlugin(
  id: string,
): ModelProviderPlugin | undefined {
  return MODEL_PROVIDER_PLUGINS.find((plugin) => plugin.id === id);
}

type AssertNever<T extends never> = T;

/**
 * Every llm-zoo provider is a plugin with a conversation format; the error
 * names the provider ids a new llm-zoo release added without one.
 */
type _EveryModelProviderHasACompatibilityKey = AssertNever<
  Exclude<
    `${ModelProvider}`,
    Extract<
      ModelProviderPluginEntry,
      { readonly compatibilityKey: string }
    >['id']
  >
>;

/**
 * Every llm-zoo provider states its default endpoint, `null` when it has no
 * HTTP route; the error names the provider ids that state none.
 */
type _EveryModelProviderStatesABaseUrl = AssertNever<
  Exclude<
    `${ModelProvider}`,
    Extract<ModelProviderPluginEntry, { readonly baseUrl: unknown }>['id']
  >
>;
