/**
 * The model provider plugin manifest — the one list every model provider
 * belongs to. Each entry is a stable id plus plain data about the
 * provider, never its wire code: its display name, the API-key page
 * and environment variable, the default HTTP endpoint and its regional pair,
 * the protocol it serves a conversation on, and the setup assistant's probe
 * model.
 *
 * Derived from this list: the provider display names, key URLs, model-source
 * and API-key provider orders (`./providers.ts`), API-key env names
 * (`./apiProviders.ts`), default endpoints (`../models/routeEndpoint.ts`).
 * The host owns the settings over it: the custom-endpoint and region
 * toggles, their keys and their control copy, and it resolves them into
 * `RouteFacts.endpoints`.
 *
 * Rules: an id is persisted (the `apiKey.<id>` secret, model configs,
 * settings, a run's backend), so it never changes and is never reused.
 * Every llm-zoo `ModelProvider` has an entry (checked below). No
 * hooks, event channels or runtime registration: a plugin is data, read by
 * code at every startup. Plain data only — the settings webview imports the
 * derived lists, so nothing here may pull in a Node or Effect module.
 */

import type { ModelProvider } from 'llm-zoo';
import type { z } from 'zod';

import type { TurnProtocolSchema } from '../protocol.js';

/**
 * OpenAI's own endpoint. Named because a route that lands on it is the one
 * the Responses WebSocket transport is known to serve: a per-model or
 * dashboard endpoint may not speak it at all.
 */
export const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/**
 * A provider served from a China and an international platform: the copy
 * that depends on which one the host's region toggle picks. "Set" is the
 * China region.
 */
interface ProviderRegion {
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
  /** Alternate region for endpoint and key-URL derivation. */
  readonly region?: ProviderRegion;
  /**
   * Default HTTP base URL, or a China/international pair chosen by the
   * region toggle. `null`: an llm-zoo provider with no HTTP route of its
   * own (checked below, so a dropped endpoint is a compile error). Absent:
   * a plugin outside llm-zoo's `ModelProvider` (`openRouter`, `kimiCode`).
   */
  readonly baseUrl?: string | RegionalBaseUrl | null;
  /** The protocol this provider serves a run's conversation on: present
   *  exactly on the providers a run can be bound to (its backend). */
  readonly protocol?: z.infer<typeof TurnProtocolSchema>;
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
    baseUrl: OPENAI_DEFAULT_ENDPOINT,
    protocol: 'openai-responses',
    setupModel: 'openai/gpt-6.1-sol',
    modelSource: true,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/',
    apiKey: true,
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic-messages',
    setupModel: 'anthropic/claude-opus-5-5',
    modelSource: true,
  },
  {
    id: 'google',
    displayName: 'Google',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    apiKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'google-interactions',
    setupModel: 'google/gemini-3.1-pro-preview',
    modelSource: true,
  },
  {
    id: 'xai',
    displayName: 'xAI',
    keyUrl: 'https://console.x.ai/',
    apiKey: true,
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai-responses',
    setupModel: 'xai/grok-4.7',
    modelSource: true,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    apiKey: true,
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai-responses',
    setupModel: 'deepseek/deepseek-v4-pro',
    modelSource: true,
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    keyUrl: 'https://platform.moonshot.cn/console',
    apiKey: true,
    // China=true is the default since moonshot.cn is the primary platform;
    // when toggled off (international), keys come from platform.moonshot.ai.
    // Keys are platform-specific — a .cn key does not work on .ai.
    region: {
      keyUrlWhenUnset: 'https://platform.moonshot.ai/console',
    },
    // Kimi Code models never reach this: their coding baseUrl wins as the
    // per-model override.
    baseUrl: {
      china: 'https://api.moonshot.cn/v1',
      international: 'https://api.moonshot.ai/v1',
    },
    protocol: 'openai-responses',
    setupModel: 'moonshot/kimi-k3',
    modelSource: true,
  },
  {
    id: 'dashscope',
    displayName: 'Qwen',
    keyUrl: 'https://dashscope.aliyun.com/api-console/',
    apiKey: true,
    region: {
      displayName: 'Bailian',
      keyUrlWhenSet: 'https://bailian.console.aliyun.com/',
    },
    baseUrl: {
      china: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
    protocol: 'openai-responses',
    setupModel: 'dashscope/qwen-plus',
    modelSource: true,
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    keyUrl: 'https://platform.minimax.io/',
    apiKey: true,
    region: {
      keyUrlWhenSet: 'https://platform.minimaxi.com/',
    },
    baseUrl: {
      china: 'https://api.minimax.cn/v1',
      international: 'https://api.minimax.io/v1',
    },
    protocol: 'openai-responses',
    setupModel: 'minimax/MiniMax-M3',
    modelSource: true,
  },
  {
    id: 'glm',
    displayName: 'GLM',
    keyUrl: 'https://open.bigmodel.cn/',
    apiKey: true,
    // China=true is the default since bigmodel.cn is the primary platform;
    // when toggled off (international), the key URL is z.ai.
    region: {
      keyUrlWhenUnset: 'https://z.ai/',
    },
    // Both regions serve Responses at /api/v1, for API and Coding Plan keys
    // alike (BigModel and Z.AI Codex guides).
    baseUrl: {
      china: 'https://open.bigmodel.cn/api/v1',
      international: 'https://api.z.ai/api/v1',
    },
    protocol: 'openai-responses',
    setupModel: 'glm/glm-5.3',
    modelSource: true,
  },
  {
    id: 'meta',
    displayName: 'Meta',
    keyUrl: 'https://dev.meta.ai/',
    apiKey: true,
    baseUrl: 'https://api.meta.ai/v1',
    protocol: 'openai-responses',
    setupModel: 'meta/muse-spark-1.3',
    modelSource: true,
  },
  {
    id: 'openRouter',
    displayName: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    apiKey: true,
    protocol: 'openrouter-chat',
    setupModel: 'anthropic/claude-sonnet-5-5',
  },
  {
    id: 'kimiCode',
    displayName: 'Kimi Code',
    keyUrl: 'https://www.kimi.com/code/console',
    apiKey: true,
    apiKeyEnvName: 'KIMI_CODE_API_KEY',
    setupModel: 'moonshot/kimi-k3',
    modelSource: true,
  },
  {
    id: 'copilot',
    displayName: 'Copilot',
    baseUrl: null,
    protocol: 'vscode-lm',
    modelSource: true,
  },
  {
    id: 'others',
    displayName: 'Others',
    baseUrl: null,
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

/** Providers with an HTTP endpoint of their own, which a host may override. */
export type EndpointProviderId = Extract<
  ModelProviderPluginEntry,
  { readonly baseUrl: string | RegionalBaseUrl }
>['id'];

/** Providers with a China and an international platform. */
export type RegionalProviderId = Extract<
  ModelProviderPluginEntry,
  { readonly baseUrl: RegionalBaseUrl }
>['id'];

/** A provider a run's conversation can be bound to: its backend. */
export type BackendProviderId = Extract<
  ModelProviderPluginEntry,
  { readonly protocol: string }
>['id'];

/** The protocol each backend provider serves a conversation on. */
export const BACKEND_PROTOCOLS = Object.fromEntries(
  MANIFEST.flatMap((plugin) =>
    'protocol' in plugin ? [[plugin.id, plugin.protocol]] : [],
  ),
) as Readonly<Record<BackendProviderId, z.infer<typeof TurnProtocolSchema>>>;

/** Look up a provider plugin by id. */
export function findModelProviderPlugin(
  id: string,
): ModelProviderPlugin | undefined {
  return MODEL_PROVIDER_PLUGINS.find((plugin) => plugin.id === id);
}

type AssertNever<T extends never> = T;

/**
 * Every llm-zoo provider with an HTTP endpoint names its protocol; the error
 * names the provider ids a new llm-zoo release added without one.
 */
type _EveryEndpointProviderNamesAProtocol = AssertNever<
  Exclude<
    `${ModelProvider}`,
    | BackendProviderId
    | Extract<ModelProviderPluginEntry, { readonly baseUrl: null }>['id']
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
