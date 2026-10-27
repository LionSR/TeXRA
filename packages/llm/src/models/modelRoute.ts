/**
 * The one decision of which route serves a model's next request. The picker,
 * the run binding and the run's backend all read {@link decideModelRoute}
 * over the same {@link RouteFacts}, and carry the decided {@link ModelRoute}
 * instead of re-asking any of its questions.
 *
 * The decision is pure. The host reads its facts once (its settings, its
 * secret store); the per-call facts (the validation override, a resumed
 * conversation's format) are the caller's.
 * Precedence: validation, the unserved gate (a model no route TeXRA reaches
 * serves), the ChatGPT and Grok subscriptions, then the direct provider key,
 * which may pay through Kimi Code or the GLM Coding Plan.
 *
 * Kimi Code has two eligibility shapes:
 *  - **exclusive** models (`kimi-for-coding`, `kimi-for-coding-highspeed`)
 *    are served ONLY by the coding endpoint (llm-zoo pins their `baseUrl` to
 *    it), so they take the `kimiCode` key whatever the toggles say;
 *  - **dual-backend** models (`kimi3`) also exist on the Moonshot open
 *    platform; the coding endpoint serves them only with "Kimi Code
 *    subscription" on and a Kimi Code key stored, and their wire ID differs
 *    (`kimi-k3` becomes `k3`, see {@link KIMI_CODE_WIRE_MODEL_IDS}).
 */
import {
  lookup,
  ModelProvider,
  type ModelConfig,
  type ReasoningMode,
} from 'llm-zoo';

import { isApiProvider } from '../providers/apiProviders.js';
import { KIMI_CODE_BASE_URL } from '../providers/providers.js';
import type { ApiKeyProviderId } from '../providers/providerPlugins.js';

/** The facts a route reads, and nothing else. */
export interface RouteFacts {
  /** A guarded package-validation run: every model binds the validation model. */
  readonly validation: boolean;
  /** The provider reasoning mode the request asks for (OpenAI `pro`), if any. */
  readonly mode?: ReasoningMode;
  /** ChatGPT subscription preferred, signed in, and not declined. */
  readonly chatgptSubscription: boolean;
  /** Grok subscription preferred, signed in, and not declined. */
  readonly xaiSubscription: boolean;
  /** A Kimi Code console key is stored. */
  readonly kimiCodeKey: boolean;
  /** The "Kimi Code subscription" switch is on and not declined. */
  readonly preferKimiCode: boolean;
  /** The GLM Coding Plan is on, not declined, and no dashboard GLM endpoint
   *  outranks its path. */
  readonly glmCodingPlan: boolean;
  /**
   * The user's input window override, in tokens, for the ChatGPT
   * subscription; `undefined` takes the window the backend grants the model.
   */
  readonly chatgptContextWindow: number | undefined;
  /**
   * The host's endpoint per provider id: a dashboard URL, or the default of
   * the region the provider's toggle picks. A provider absent here takes its
   * catalog default (`resolveRouteEndpoint`).
   */
  readonly endpoints: Readonly<Partial<Record<string, string>>>;
}

/** The facts {@link decideModelRoute} reads. */
export type RouteDecisionFacts = Omit<
  RouteFacts,
  'chatgptContextWindow' | 'endpoints'
>;

/** The facts under which a model takes its own key: no preference is on. */
export const OWN_KEY_ROUTE_FACTS: RouteDecisionFacts = {
  validation: false,
  chatgptSubscription: false,
  xaiSubscription: false,
  kimiCodeKey: false,
  preferKimiCode: false,
  glmCodingPlan: false,
};

/** The host half of {@link RouteFacts}, shared by every model. */
export type HostRouteFacts = Omit<RouteFacts, 'validation'>;

/** What a direct provider key pays through. */
export type ApiKeyUsageRoute =
  'api-key' | 'kimi-code-subscription' | 'glm-coding-plan-subscription';

/** The route a model's next request takes, decided by {@link decideModelRoute}. */
export type ModelRoute =
  | { readonly kind: 'validation' }
  | {
      readonly kind: 'chatgpt-subscription';
      /** The input window the Codex backend grants this model. */
      readonly contextWindow: number;
    }
  | { readonly kind: 'xai-subscription' }
  | {
      readonly kind: 'api-key';
      readonly provider: ApiKeyProviderId;
      readonly usageRoute: ApiKeyUsageRoute;
    }
  /** No provider key can serve the model directly. */
  | { readonly kind: 'no-api-key' }
  /** No route TeXRA reaches serves the model (see {@link isUnservedModel}). */
  | { readonly kind: 'unserved' };

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

/** Trailing llm-zoo date pin (`-2026-04-23`) on a model `id`. */
const CODEX_MODEL_DATE_PIN = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The model id the Codex backend keys on: the API `id` with its llm-zoo date
 * pin stripped.
 *
 * Never the `shortName`. That is llm-zoo's display abbreviation, and for every
 * Codex-eligible model but one it happens to equal the backend slug — which is
 * why preferring it went unnoticed. The exception is the GPT-5.6 family, whose
 * members are `gpt-5.6-sol`, `-terra` and `-luna`: there is no bare `gpt-5.6`
 * model anywhere, but that is exactly the `shortName` llm-zoo gives Sol. We
 * sent it and the backend answered
 * `The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
 * account.` — a message that reads as a subscription problem and sends users
 * to check their plan, when the id was simply not a model.
 */
export function codexBackendModelId(
  config: Pick<ModelConfig, 'ref' | 'id'>,
): string {
  // The canonical registry `id`, not the caller's. A bound config may
  // already carry the harness's short-name rewrite (`ModelAccess.ts`), which
  // overwrites `id` with `shortName` when "Prefer short model names" is on — reinstating the exact
  // `gpt-5.6` this function exists to never send. `ref` is the
  // registry key and is not rewritten anywhere on this path, so it is the one
  // field that still identifies the model. A config the registry does not
  // know (a runtime-discovered entry) has no canonical entry to read, so its
  // own `id` is the only answer available.
  const canonical = lookup(config.ref)?.id;
  return (canonical ?? config.id).replace(CODEX_MODEL_DATE_PIN, '');
}

/**
 * Whether the Kimi Code coding endpoint serves `model`: the llm-zoo
 * `kimiSubscription` flag on a Moonshot model. Serving status is a fact about
 * the Kimi Code backend, not derivable from other model fields.
 */
export function isKimiSubscriptionEligible(
  model: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): boolean {
  return (
    model.provider === ModelProvider.MOONSHOT && model.kimiSubscription === true
  );
}

/**
 * Whether the coding endpoint ALONE serves `model`: llm-zoo pins its `baseUrl`
 * there, so no open-platform route exists.
 */
export function isKimiCodeExclusiveModel(
  model: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): boolean {
  return (
    isKimiSubscriptionEligible(model) && model.baseUrl === KIMI_CODE_BASE_URL
  );
}

/** Product-facing model source; direct managed services own their own group. */
export function resolveModelSource(
  config: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string {
  return isKimiCodeExclusiveModel(config) ? 'kimiCode' : config.provider;
}

/**
 * The config fields of a route billed by subscription, not per token, over
 * the context window the caller resolved for that route. A covered route
 * bills no tier either: a long-prompt or fast-tier rate left on the config
 * would price a request the subscription paid for.
 */
export function zeroCostAccessOverrides(contextWindow: number): {
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

/** Decide the route `config` takes under `facts`. Pure. */
export function decideModelRoute(
  config: ModelConfig,
  facts: RouteDecisionFacts,
): ModelRoute {
  if (facts.validation) return { kind: 'validation' };
  // Only OpenRouter serves this model, and TeXRA does not call OpenRouter.
  if (config.openRouterOnly) return { kind: 'unserved' };
  // The subscriptions are preferences: signed out, the model takes its key.
  // The Codex backend serves no provider reasoning mode (OpenAI `pro`).
  const codex = codexSubscriptionOf(config);
  if (
    facts.chatgptSubscription &&
    facts.mode === undefined &&
    codex !== undefined
  ) {
    return { kind: 'chatgpt-subscription', contextWindow: codex.contextWindow };
  }
  if (facts.xaiSubscription && config.provider === ModelProvider.XAI) {
    return { kind: 'xai-subscription' };
  }
  if (
    isKimiCodeExclusiveModel(config) ||
    (isKimiSubscriptionEligible(config) &&
      facts.preferKimiCode &&
      facts.kimiCodeKey)
  ) {
    return {
      kind: 'api-key',
      provider: 'kimiCode',
      usageRoute: 'kimi-code-subscription',
    };
  }
  if (!isApiProvider(config.provider)) return { kind: 'no-api-key' };
  // A per-model base URL outranks the plan's path (`./routeEndpoint.ts`).
  const onCodingPlan =
    config.provider === ModelProvider.GLM &&
    facts.glmCodingPlan &&
    !config.baseUrl;
  return {
    kind: 'api-key',
    provider: config.provider,
    usageRoute: onCodingPlan ? 'glm-coding-plan-subscription' : 'api-key',
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
 * The config `config` runs with on `route`: a subscription's zero per-token
 * price and context ceiling, and for a dual-backend Kimi model on Kimi Code
 * the coding wire id and tier window. The endpoint is not part of it: the
 * route itself names the credential and endpoint (`./routeEndpoint.ts`).
 */
export function routeConfig(
  config: ModelConfig,
  route: ModelRoute,
  facts: Pick<RouteFacts, 'chatgptContextWindow'>,
): ModelConfig {
  switch (route.kind) {
    case 'chatgpt-subscription': {
      const inputTokenLimit = Math.min(
        facts.chatgptContextWindow ?? route.contextWindow,
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
        // The ChatGPT-subscription backend takes no input files, so the
        // binding's PDF admission degrades a PDF instead of sending a shape
        // the backend rejects.
        capabilities: { ...config.capabilities, supportsNativePdf: false },
      };
    }
    case 'xai-subscription':
      return { ...config, ...zeroCostAccessOverrides(config.contextWindow) };
    case 'api-key': {
      if (route.provider !== 'kimiCode' || isKimiCodeExclusiveModel(config)) {
        return config;
      }
      const wireId = KIMI_CODE_WIRE_MODEL_IDS[config.id] ?? config.id;
      return {
        ...config,
        id: wireId,
        shortName: wireId,
        ...zeroCostAccessOverrides(
          Math.min(KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW, config.contextWindow),
        ),
      };
    }
    default:
      return config;
  }
}
