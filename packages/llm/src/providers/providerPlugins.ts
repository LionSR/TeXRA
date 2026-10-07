/**
 * The model provider plugin manifest — the one list every model provider
 * belongs to. Each entry is a stable id plus plain data about the
 * provider, never its wire code: its own name, whether it takes an API key
 * and under which environment variable, and the default HTTP endpoint and
 * its regional pair. Beside it, `BACKEND_PROTOCOLS` names the protocol each
 * provider a run can be bound to speaks.
 *
 * Derived from this list: the provider display name and the API-key provider
 * order (`./providers.ts`), API-key env names (`./apiProviders.ts`), default
 * endpoints (`../models/routeEndpoint.ts`). The app owns everything a user
 * sees about a provider beyond its name: key pages, picker grouping and the
 * setup assistant's probe models, as well as the settings over this list —
 * the custom-endpoint and region toggles, their keys and their control copy,
 * which it resolves into `RouteFacts.endpoints`.
 *
 * Rules: an id is persisted (the `apiKey.<id>` secret, model configs,
 * settings, a run's backend), so it never changes and is never reused.
 * Every llm-zoo `ModelProvider` has an entry (checked below). No
 * hooks, event channels or runtime registration: a plugin is data, read by
 * code at every startup. Plain data only — the settings webview imports the
 * derived names, so nothing here may pull in a Node or Effect module.
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

/** A default endpoint that depends on the provider's region toggle. */
interface RegionalBaseUrl {
  readonly china: string;
  readonly international: string;
}

/** One model provider plugin. */
interface ModelProviderPlugin {
  /** Stable, persisted identifier: the llm-zoo provider or API-key id. */
  readonly id: string;
  /** The provider's own name. */
  readonly displayName: string;
  /** Users can configure a direct API key for this provider. */
  readonly apiKey?: true;
  /** Environment variable for the key when it is not `<ID>_API_KEY`. */
  readonly apiKeyEnvName?: string;
  /**
   * Default HTTP base URL, or a China/international pair chosen by the
   * region toggle. `null`: an llm-zoo provider with no HTTP route of its
   * own (checked below, so a dropped endpoint is a compile error). Absent:
   * a plugin outside llm-zoo's `ModelProvider` (`openRouter`, `kimiCode`).
   */
  readonly baseUrl?: string | RegionalBaseUrl | null;
}

/** Every model provider, in display order. */
const MANIFEST = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    apiKey: true,
    baseUrl: OPENAI_DEFAULT_ENDPOINT,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    apiKey: true,
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'google',
    displayName: 'Google',
    apiKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    apiKey: true,
    baseUrl: 'https://api.x.ai/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    apiKey: true,
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    apiKey: true,
    // Kimi Code models never reach this: their coding baseUrl wins as the
    // per-model override.
    baseUrl: {
      china: 'https://api.moonshot.cn/v1',
      international: 'https://api.moonshot.ai/v1',
    },
  },
  {
    id: 'dashscope',
    displayName: 'Qwen',
    apiKey: true,
    baseUrl: {
      china: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    apiKey: true,
    baseUrl: {
      china: 'https://api.minimax.cn/v1',
      international: 'https://api.minimax.io/v1',
    },
  },
  {
    id: 'glm',
    displayName: 'GLM',
    apiKey: true,
    // Both regions serve Responses at /api/v1, for API and Coding Plan keys
    // alike (BigModel and Z.AI Codex guides).
    baseUrl: {
      china: 'https://open.bigmodel.cn/api/v1',
      international: 'https://api.z.ai/api/v1',
    },
  },
  {
    id: 'meta',
    displayName: 'Meta',
    apiKey: true,
    baseUrl: 'https://api.meta.ai/v1',
  },
  {
    id: 'openRouter',
    displayName: 'OpenRouter',
    apiKey: true,
  },
  {
    id: 'kimiCode',
    displayName: 'Kimi Code',
    apiKey: true,
    apiKeyEnvName: 'KIMI_CODE_API_KEY',
  },
  {
    id: 'copilot',
    displayName: 'Copilot',
    baseUrl: null,
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

/**
 * The protocol each provider a run's conversation can be bound to (its
 * backend) serves that conversation on, keyed by plugin id.
 */
export const BACKEND_PROTOCOLS = Object.freeze({
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
  google: 'google-interactions',
  xai: 'openai-responses',
  deepseek: 'openai-responses',
  moonshot: 'openai-responses',
  dashscope: 'openai-responses',
  minimax: 'openai-responses',
  glm: 'openai-responses',
  meta: 'openai-responses',
  openRouter: 'openrouter-chat',
  copilot: 'vscode-lm',
} satisfies Partial<
  Record<ModelProviderPluginEntry['id'], z.infer<typeof TurnProtocolSchema>>
>);

/** A provider a run's conversation can be bound to: its backend. */
export type BackendProviderId = keyof typeof BACKEND_PROTOCOLS;

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
