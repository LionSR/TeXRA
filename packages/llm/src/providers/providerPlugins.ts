/**
 * The model provider plugin manifest — the one list every model provider
 * belongs to. Each entry is a stable id plus plain data about the
 * provider, never its wire code: its own name, whether it takes an API key
 * and under which environment variable, and the default HTTP endpoint and
 * its regional pair. Beside it, `BACKEND_PROTOCOLS` names the protocol each
 * provider a run can be bound to speaks.
 *
 * Derived from this list: the provider display name, the API-key provider
 * order and API-key env names (`./providers.ts`), default endpoints
 * (`decideModelRoute`). The app owns everything a user
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

import type { TurnProtocolSchema } from '../protocol.js';

/**
 * OpenAI's own endpoint. Named because a route that lands on it is the one
 * the Responses WebSocket transport is known to serve: a per-model or
 * dashboard endpoint may not speak it at all.
 */
export const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/** xAI's own endpoint, the one surface a Grok subscription's token serves. */
export const XAI_DEFAULT_ENDPOINT = 'https://api.x.ai/v1';

/** A default endpoint that depends on the provider's region toggle. */
export interface RegionalBaseUrl {
  readonly china: string;
  readonly international: string;
}

/**
 * One model provider plugin, by what TeXRA does with it:
 * - `backend`: an llm-zoo provider a run binds to, over its own HTTP
 *   endpoint (a default base URL, or a China/international pair the region
 *   toggle picks), with a direct API key;
 * - `plan-key`: a coding plan's own key outside llm-zoo (`kimiCode`), read
 *   from its named variable;
 * - `unserved`: an llm-zoo provider whose models TeXRA does not serve.
 */
export type ModelProviderPlugin = {
  /** Stable, persisted identifier: the llm-zoo provider or API-key id. */
  readonly id: string;
  /** The provider's own name. */
  readonly displayName: string;
} & (
  | {
      readonly kind: 'backend';
      readonly baseUrl: string | RegionalBaseUrl;
    }
  | { readonly kind: 'plan-key'; readonly apiKeyEnvName: string }
  | { readonly kind: 'unserved' }
);

/** Every model provider, in display order. */
const MANIFEST = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    kind: 'backend',
    baseUrl: OPENAI_DEFAULT_ENDPOINT,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    kind: 'backend',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'google',
    displayName: 'Google',
    kind: 'backend',
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    kind: 'backend',
    baseUrl: XAI_DEFAULT_ENDPOINT,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    kind: 'backend',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    kind: 'backend',
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
    kind: 'backend',
    baseUrl: {
      china: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    kind: 'backend',
    baseUrl: {
      china: 'https://api.minimax.cn/v1',
      international: 'https://api.minimax.io/v1',
    },
  },
  {
    id: 'glm',
    displayName: 'GLM',
    kind: 'backend',
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
    kind: 'backend',
    baseUrl: 'https://api.meta.ai/v1',
  },
  {
    id: 'kimiCode',
    displayName: 'Kimi Code',
    kind: 'plan-key',
    apiKeyEnvName: 'KIMI_CODE_API_KEY',
  },
  {
    id: 'copilot',
    displayName: 'Copilot',
    kind: 'unserved',
  },
  {
    id: 'others',
    displayName: 'Others',
    kind: 'unserved',
  },
] as const satisfies readonly ModelProviderPlugin[];

/** Every model provider plugin, in display order. */
export const MODEL_PROVIDER_PLUGINS: readonly ModelProviderPlugin[] = MANIFEST;

/** Ids of the providers users can configure a direct API key for. */
export type ApiKeyProviderId = Extract<
  (typeof MANIFEST)[number],
  { readonly kind: 'backend' | 'plan-key' }
>['id'];

/**
 * Provider IDs where users can configure direct API keys — the single source
 * for direct key-provider enumeration, derived from the plugin manifest.
 * Order = display order in the settings key rows.
 */
export const API_KEY_PROVIDER_IDS: readonly ApiKeyProviderId[] = Object.freeze(
  MANIFEST.flatMap((plugin) => (plugin.kind === 'unserved' ? [] : [plugin.id])),
);

/** Providers with a China and an international platform. */
export type RegionalProviderId = Extract<
  (typeof MANIFEST)[number],
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
} satisfies Record<
  Extract<(typeof MANIFEST)[number], { readonly kind: 'backend' }>['id'],
  typeof TurnProtocolSchema.Type
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
 * Every llm-zoo provider is a backend (served, with its endpoint, key and,
 * through `BACKEND_PROTOCOLS`, its protocol) or unserved (`copilot`,
 * `others`): a new llm-zoo release's provider fails here, naming its id,
 * until that is decided, instead of vanishing from the picker.
 */
type _EveryModelProviderIsDecided = AssertNever<
  Exclude<
    `${ModelProvider}`,
    Extract<
      (typeof MANIFEST)[number],
      { readonly kind: 'backend' | 'unserved' }
    >['id']
  >
>;
