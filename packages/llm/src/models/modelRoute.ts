/**
 * The one decision of which route serves a model's next request. The picker,
 * the run binding and the run's backend all read {@link decideModelRoute}
 * over the same {@link RouteFacts}, and carry the decided {@link ModelRoute}
 * instead of re-asking any of its questions.
 *
 * The decision is pure. The host reads its facts once (its settings, its
 * secret store); the per-call facts (a resumed conversation's format) are the
 * caller's. Precedence: the unserved gate (a model no route TeXRA reaches
 * serves), the ChatGPT and Grok subscriptions, then the direct
 * provider key, which may pay through Kimi Code or the GLM Coding Plan.
 *
 * The decision names the route's endpoint too, as an explicit URL: the
 * package binds a model to a stated deployment, never an SDK default. A
 * subscription token is accepted only at its own surface, so the ChatGPT
 * plan goes to the public Responses API its token is issued for and the Grok
 * plan to xAI's API, never to a per-model or dashboard endpoint. A key route
 * takes the per-model base URL, then (Kimi Code) the coding endpoint, then
 * the host's endpoint for the provider, then the provider plugin's default
 * (`../providers/providerPlugins.ts`), a regional one's international
 * platform as the region setting defaults. A GLM Coding Plan key takes its
 * region's Responses endpoint, the same one an API key does.
 *
 * Kimi Code has two eligibility shapes ({@link kimiCodeServing}):
 *  - **exclusive** models (`kimi-for-coding`, `kimi-for-coding-highspeed`)
 *    are served ONLY by the coding endpoint (llm-zoo pins their `baseUrl` to
 *    it), so they take the `kimiCode` key whatever the toggles say;
 *  - **dual-backend** models (`kimi3`) also exist on the Moonshot open
 *    platform; the coding endpoint serves them only with "Kimi Code
 *    subscription" on and a Kimi Code key stored, and their wire ID differs
 *    (`kimi-k3` becomes `k3`, see {@link KIMI_CODE_WIRE_MODEL_IDS}).
 */
import { absurd } from 'effect';
import { ModelProvider, type ModelConfig, type ReasoningMode } from 'llm-zoo';

import { PLAN_ROUTES, type PlanRoute } from '../errors.js';
import { isApiProvider } from '../providers/apiProviders.js';
import { KIMI_CODE_BASE_URL } from '../providers/providers.js';
import {
  type ApiKeyProviderId,
  findModelProviderPlugin,
  OPENAI_DEFAULT_ENDPOINT,
  XAI_DEFAULT_ENDPOINT,
} from '../providers/providerPlugins.js';

/** A plan a direct provider key pays through (its credential is a `key`). */
export type KeyPlanRoute = {
  [P in PlanRoute]: (typeof PLAN_ROUTES)[P]['credential'] extends 'key'
    ? P
    : never;
}[PlanRoute];

/** The facts a route reads, and nothing else. */
export interface RouteFacts {
  /** The provider reasoning mode the request asks for (OpenAI `pro`), if any. */
  readonly mode?: ReasoningMode;
  /**
   * The plans a request may bill: preferred, signed in or keyed, and not
   * declined. The GLM Coding Plan is absent when a dashboard GLM endpoint
   * outranks its path.
   */
  readonly plans: readonly PlanRoute[];
  /**
   * The user's input window override, in tokens, for the ChatGPT
   * subscription; `undefined` takes the window the backend grants the model.
   */
  readonly chatgptContextWindow: number | undefined;
  /**
   * The host's endpoint per provider id: a dashboard URL, or the default of
   * the region the provider's toggle picks. A provider absent here takes its
   * plugin's default.
   */
  readonly endpoints: Readonly<Partial<Record<string, string>>>;
}

/**
 * The facts under which a model takes its own key at its default endpoint:
 * no plan is on and the host names no endpoint.
 */
export const OWN_KEY_ROUTE_FACTS: RouteFacts = Object.freeze({
  plans: Object.freeze([]),
  chatgptContextWindow: undefined,
  endpoints: Object.freeze({}),
});

/**
 * The route a model's next request takes, decided by {@link decideModelRoute}.
 * A route that bills a credential names its kind (a signed-in `session`, or
 * an `api-key`) and the plan it pays through (`plan`; none for a key paid
 * per token), so the billing route is `plan ?? 'api-key'` on either.
 */
export type ModelRoute =
  | {
      readonly kind: 'session';
      readonly plan: 'chatgpt-subscription';
      readonly endpoint: string;
      /** The input window: the user's override, else what the Codex backend grants. */
      readonly contextWindow: number;
    }
  | {
      readonly kind: 'session';
      readonly plan: Exclude<PlanRoute, KeyPlanRoute | 'chatgpt-subscription'>;
      readonly endpoint: string;
    }
  | {
      readonly kind: 'api-key';
      readonly endpoint: string;
      readonly provider: ApiKeyProviderId;
      readonly plan: KeyPlanRoute | null;
    }
  /** No provider key can serve the model directly. */
  | { readonly kind: 'no-api-key' }
  /** No route TeXRA reaches serves the model (see {@link isUnservedModel}). */
  | { readonly kind: 'unserved' };

/** The routes that bill a credential: a key, or a session plan's sign-in. */
export type CredentialRoute = Exclude<
  ModelRoute,
  { kind: 'no-api-key' | 'unserved' }
>;

/**
 * How the Codex backend serves `model` on a ChatGPT subscription, or
 * `undefined` when it does not: the llm-zoo `codexSubscription` entry, which
 * records the backend's own model catalog and the input window it grants.
 * Serving status is a fact about the backend, so it lives in the registry
 * data; a retired model must drop the entry there.
 */
function codexSubscriptionOf(
  model: ModelConfig,
): ModelConfig['codexSubscription'] {
  return model.provider === ModelProvider.OPENAI
    ? model.codexSubscription
    : undefined;
}

/**
 * Whether no route TeXRA reaches serves `config`: llm-zoo retired the model,
 * or only OpenRouter serves it, which TeXRA does not call.
 */
export function isUnservedModel(
  config: Pick<ModelConfig, 'retired' | 'openRouterOnly'>,
): boolean {
  return config.retired === true || config.openRouterOnly === true;
}

/**
 * Whether the model issues independent tool calls together in one response
 * and handles their results in any order. The prompt tells such a model it
 * may batch calls; every other model is told to call one tool at a time.
 * Only Anthropic's models are known to; llm-zoo carries no flag for it.
 */
export function issuesParallelToolCalls(
  config: Pick<ModelConfig, 'provider'>,
): boolean {
  return config.provider === ModelProvider.ANTHROPIC;
}

/** Trailing llm-zoo date pin (`-2026-04-23`) on a model `id`. */
const CODEX_MODEL_DATE_PIN = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The model id the Codex backend keys on: the API `id` with its llm-zoo date
 * pin stripped.
 *
 * Never the `shortName`: that is llm-zoo's display abbreviation, and for
 * GPT-5.6 Sol it is a bare `gpt-5.6`, which is not a model. The backend
 * answers it with "The 'gpt-5.6' model is not supported when using Codex with
 * a ChatGPT account", which reads as a plan problem rather than a bad id.
 */
export function codexBackendModelId(config: Pick<ModelConfig, 'id'>): string {
  return config.id.replace(CODEX_MODEL_DATE_PIN, '');
}

/**
 * How the Kimi Code coding endpoint serves `model`: `only` it (llm-zoo pins
 * the model's `baseUrl` there, so no open-platform route exists),
 * `with-plan` beside the Moonshot open platform (the coding endpoint takes it
 * only with the plan on), or `undefined` when it does not serve it. Serving
 * status is the llm-zoo `kimiSubscription` flag on a Moonshot model: a fact
 * about the Kimi Code backend, not derivable from other model fields.
 */
export function kimiCodeServing(
  model: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): 'only' | 'with-plan' | undefined {
  if (
    model.provider !== ModelProvider.MOONSHOT ||
    model.kimiSubscription !== true
  )
    return undefined;
  return model.baseUrl === KIMI_CODE_BASE_URL ? 'only' : 'with-plan';
}

/** Product-facing model source; direct managed services own their own group. */
export function resolveModelSource(
  config: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string {
  return kimiCodeServing(config) === 'only' ? 'kimiCode' : config.provider;
}

/**
 * The config fields of a route billed by subscription, not per token, over
 * the context window the caller resolved for that route. A covered route
 * bills no tier either: a long-prompt or fast-tier rate left on the config
 * would price a request the subscription paid for.
 */
function zeroCostAccessOverrides(contextWindow: number): {
  readonly inputPrice: 0;
  readonly outputPrice: 0;
  readonly contextWindow: number;
  readonly longContextPricing: undefined;
  readonly tiers: undefined;
} {
  return {
    inputPrice: 0,
    outputPrice: 0,
    contextWindow,
    longContextPricing: undefined,
    tiers: undefined,
  };
}

/**
 * A provider plugin's default endpoint: its one URL, or its international
 * platform's; `undefined` for a provider with no HTTP route.
 */
function pluginEndpoint(provider: string): string | undefined {
  const plugin = findModelProviderPlugin(provider);
  if (plugin?.kind !== 'backend') return undefined;
  return typeof plugin.baseUrl === 'string'
    ? plugin.baseUrl
    : plugin.baseUrl.international;
}

/** The endpoint a provider key takes for `config`: the per-model base URL,
 *  the host's endpoint for its provider, else the plugin's default. */
const keyEndpoint = (config: ModelConfig, facts: RouteFacts) =>
  config.baseUrl ??
  facts.endpoints[config.provider] ??
  pluginEndpoint(config.provider);

/**
 * The route each plan gives `config` under `facts`, or `undefined` when the
 * plan does not take it. Keyed by every plan, so a new plan does not compile
 * until it says when it serves a model; read in key order, which is the
 * precedence: the subscriptions are preferences, so a model whose plans are
 * all off or ineligible takes its own key.
 */
const PLAN_DECISIONS = Object.freeze({
  // The Codex backend serves no provider reasoning mode (OpenAI `pro`).
  'chatgpt-subscription': (config, facts) => {
    const codex = codexSubscriptionOf(config);
    return facts.plans.includes('chatgpt-subscription') &&
      facts.mode === undefined &&
      codex !== undefined
      ? {
          kind: 'session',
          plan: 'chatgpt-subscription',
          endpoint: OPENAI_DEFAULT_ENDPOINT,
          contextWindow: facts.chatgptContextWindow ?? codex.contextWindow,
        }
      : undefined;
  },
  'xai-subscription': (config, facts) =>
    facts.plans.includes('xai-subscription') &&
    config.provider === ModelProvider.XAI
      ? {
          kind: 'session',
          plan: 'xai-subscription',
          endpoint: XAI_DEFAULT_ENDPOINT,
        }
      : undefined,
  // An exclusive model takes the plan whatever the toggles say.
  'kimi-code-subscription': (config, facts) => {
    const serving = kimiCodeServing(config);
    return serving === 'only' ||
      (serving === 'with-plan' &&
        facts.plans.includes('kimi-code-subscription'))
      ? {
          kind: 'api-key',
          endpoint: config.baseUrl ?? KIMI_CODE_BASE_URL,
          provider: PLAN_ROUTES['kimi-code-subscription'].provider,
          plan: 'kimi-code-subscription',
        }
      : undefined;
  },
  // A per-model base URL outranks the plan's path; the plan's key takes the
  // endpoint an API key does.
  'glm-coding-plan-subscription': (config, facts) => {
    if (
      config.provider !== ModelProvider.GLM ||
      !facts.plans.includes('glm-coding-plan-subscription') ||
      config.baseUrl
    )
      return undefined;
    const endpoint = keyEndpoint(config, facts);
    return endpoint === undefined
      ? undefined
      : {
          kind: 'api-key',
          endpoint,
          provider: PLAN_ROUTES['glm-coding-plan-subscription'].provider,
          plan: 'glm-coding-plan-subscription',
        };
  },
} satisfies Record<
  PlanRoute,
  (config: ModelConfig, facts: RouteFacts) => ModelRoute | undefined
>);

/** Decide the route `config` takes under `facts`. Pure. */
export function decideModelRoute(
  config: ModelConfig,
  facts: RouteFacts,
): ModelRoute {
  if (isUnservedModel(config)) return { kind: 'unserved' };
  for (const decide of Object.values(PLAN_DECISIONS)) {
    const route = decide(config, facts);
    if (route !== undefined) return route;
  }
  // A provider with no HTTP route of its own has no key route either.
  const endpoint = keyEndpoint(config, facts);
  if (!isApiProvider(config.provider) || endpoint === undefined)
    return { kind: 'no-api-key' };
  return {
    kind: 'api-key',
    endpoint,
    provider: config.provider,
    plan: null,
  };
}

/**
 * Open-platform `id` to coding-endpoint wire ID. Exclusive plan aliases
 * already use their wire ID as `id` and pass through unchanged.
 */
const KIMI_CODE_WIRE_MODEL_IDS: Readonly<Record<string, string>> = {
  'kimi-k3': 'k3',
};

/**
 * Conservative context budget on the coding endpoint: the Moderato tier serves
 * 256K; only Allegretto+ unlocks 1M on `k3`. The open-platform registry entry
 * advertises the full 1M, so cap it here: overstating the window breaks
 * compaction budgets for Moderato members.
 */
const KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW = 262_144;

/**
 * The config `config` runs with on `route`. Every route with a plan is paid
 * by its subscription, so its per-token prices are zero; the ChatGPT plan
 * also takes its granted context window, and a dual-backend Kimi model on
 * Kimi Code its coding wire id and tier window. The endpoint is not part of
 * it: the route itself names it.
 */
export function routeConfig(
  config: ModelConfig,
  route: ModelRoute,
): ModelConfig {
  if (!('plan' in route) || route.plan === null) return config;
  switch (route.plan) {
    case 'chatgpt-subscription': {
      const inputTokenLimit = Math.min(
        route.contextWindow,
        config.contextWindow,
      );
      return {
        ...config,
        ...zeroCostAccessOverrides(
          Math.min(
            inputTokenLimit + config.maxOutputTokens,
            config.contextWindow,
          ),
        ),
      };
    }
    case 'kimi-code-subscription': {
      if (kimiCodeServing(config) === 'only')
        return { ...config, ...zeroCostAccessOverrides(config.contextWindow) };
      const wireId = KIMI_CODE_WIRE_MODEL_IDS[config.id] ?? config.id;
      return {
        ...config,
        id: wireId,
        ...zeroCostAccessOverrides(
          Math.min(KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW, config.contextWindow),
        ),
      };
    }
    case 'xai-subscription':
    case 'glm-coding-plan-subscription':
      return { ...config, ...zeroCostAccessOverrides(config.contextWindow) };
    default:
      return absurd(route.plan);
  }
}
