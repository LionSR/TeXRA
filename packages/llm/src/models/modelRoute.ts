/**
 * The one decision of which route serves a model's next request. The picker,
 * the run binding, the compatibility key and the Copilot fallback all read
 * {@link decideModelRoute} over the same {@link RouteFacts}, and carry the
 * decided {@link ModelRoute} instead of re-asking any of its questions.
 *
 * The decision is pure. The host reads its facts once (its settings, its
 * secret store, its editor); the per-call facts (the validation override,
 * the Copilot preference, a resumed conversation's format) are the caller's.
 * The editor's Copilot route is the host's own type, `C`: the package carries
 * it on the decision and never reads it.
 * Precedence: validation, Copilot, the OpenRouter-unsupported gate, the
 * ChatGPT and Grok subscriptions, OpenRouter, then the direct provider key,
 * which may pay through Kimi Code or the GLM Coding Plan.
 *
 * Kimi Code has two eligibility shapes:
 *  - **exclusive** models (`kimi-for-coding`, `kimi-for-coding-highspeed`)
 *    are served ONLY by the coding endpoint (llm-zoo pins their `baseUrl` to
 *    it), so they take the `kimiCode` key whatever the toggles say;
 *  - **dual-backend** models (`kimi3`) also exist on the Moonshot open
 *    platform; the coding endpoint serves them only with OpenRouter off,
 *    "Kimi Code subscription" on and a Kimi Code key stored, and their wire ID
 *    differs (`kimi-k3` becomes `k3`, see {@link KIMI_CODE_WIRE_MODEL_IDS}).
 */
import { ModelProvider, type ModelConfig, type ReasoningMode } from 'llm-zoo';

import { isApiProvider, type ApiProvider } from '../providers/apiProviders.js';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from './kimiCodeRetryGate.js';
import {
  isOpenRouterRoutingUnsupported,
  shouldRouteModelThroughOpenRouter,
} from './openRouterRouting.js';
import { zeroCostAccessOverrides } from './subscriptionAccessOverrides.js';

/** The facts a route reads, and nothing else. */
export interface RouteFacts<C = unknown> {
  /** A guarded package-validation run: every model binds the validation model. */
  readonly validation: boolean;
  /** The user asked the editor (Copilot) to serve this model. */
  readonly prefersCopilot: boolean;
  /**
   * The route the editor offers for this model, discovered for this decision
   * (only when the decision can land on Copilot). A Copilot decision carries
   * it, so nothing downstream re-reads the editor.
   */
  readonly copilotRoute: C | undefined;
  /** The OpenRouter choice: the live toggle, or a resumed format's. */
  readonly useOpenRouter: boolean;
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
   * The context window, in tokens, the user grants the ChatGPT subscription
   * (`routeConfig` caps the model's window at it).
   */
  readonly chatgptContextWindow: number;
  /**
   * The host's endpoint per provider id: a dashboard URL, or the default of
   * the region the provider's toggle picks. A provider absent here takes its
   * catalog default (`resolveRouteEndpoint`).
   */
  readonly endpoints: Readonly<Partial<Record<string, string>>>;
}

/** The facts {@link decideModelRoute} reads. */
export type RouteDecisionFacts<C = unknown> = Omit<
  RouteFacts<C>,
  'chatgptContextWindow' | 'endpoints'
>;

/** The facts under which a model takes its own key: no preference is on. */
export const OWN_KEY_ROUTE_FACTS: RouteDecisionFacts<never> = {
  validation: false,
  prefersCopilot: false,
  copilotRoute: undefined,
  useOpenRouter: false,
  chatgptSubscription: false,
  xaiSubscription: false,
  kimiCodeKey: false,
  preferKimiCode: false,
  glmCodingPlan: false,
};

/** The host half of {@link RouteFacts}, shared by every model. */
export type HostRouteFacts = Omit<
  RouteFacts,
  'validation' | 'prefersCopilot' | 'copilotRoute'
>;

/** What a direct provider key pays through. */
export type ApiKeyUsageRoute =
  'api-key' | 'kimi-code-subscription' | 'glm-coding-plan-subscription';

/** The route a model's next request takes, decided by {@link decideModelRoute}. */
export type ModelRoute<C = unknown> =
  | { readonly kind: 'validation' }
  | {
      readonly kind: 'copilot';
      /** The discovered route; absent when the editor offers none now. */
      readonly route: C | undefined;
    }
  | { readonly kind: 'openrouter-unsupported' }
  | { readonly kind: 'chatgpt-subscription' }
  | { readonly kind: 'xai-subscription' }
  | { readonly kind: 'openrouter' }
  | {
      readonly kind: 'api-key';
      readonly provider: ApiProvider;
      readonly usageRoute: ApiKeyUsageRoute;
    }
  /** No provider key can serve the model directly. */
  | { readonly kind: 'no-api-key' };

/**
 * Whether the Codex backend serves `model` on a ChatGPT subscription: the
 * llm-zoo `codexSubscription` flag, which records the backend's own model
 * manifest. Serving status is a fact about the backend, so it lives in the
 * registry data; a retired model must flip the flag there.
 */
function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  return (
    model.provider === ModelProvider.OPENAI &&
    !model.openRouterOnly &&
    model.codexSubscription === true
  );
}

/** Decide the route `config` takes under `facts`. Pure. */
export function decideModelRoute<C>(
  config: ModelConfig,
  facts: RouteDecisionFacts<C>,
): ModelRoute<C> {
  if (facts.validation) return { kind: 'validation' };
  // Editor-supplied models cannot be proxied through OpenRouter, and a
  // preference is a hard route choice (#9635) for every request the editor
  // can serve. The editor sends its own reasoning controls, so a provider
  // mode (OpenAI `pro`) takes the model's own route, as the Codex
  // subscription preference below does.
  if (
    (facts.prefersCopilot && facts.mode === undefined) ||
    config.provider === ModelProvider.COPILOT
  ) {
    return { kind: 'copilot', route: facts.copilotRoute };
  }
  if (isOpenRouterRoutingUnsupported(config, facts.useOpenRouter, facts.mode)) {
    return { kind: 'openrouter-unsupported' };
  }
  // The subscriptions are preferences: signed out, the model takes its key.
  // The Codex backend serves no provider reasoning mode (OpenAI `pro`).
  if (
    facts.chatgptSubscription &&
    facts.mode === undefined &&
    !shouldRouteModelThroughOpenRouter(config, facts.useOpenRouter) &&
    isCodexSubscriptionEligible(config)
  ) {
    return { kind: 'chatgpt-subscription' };
  }
  if (
    facts.xaiSubscription &&
    !facts.useOpenRouter &&
    config.provider === ModelProvider.XAI &&
    !config.openRouterOnly
  ) {
    return { kind: 'xai-subscription' };
  }
  if (shouldRouteModelThroughOpenRouter(config, facts.useOpenRouter)) {
    return { kind: 'openrouter' };
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
        facts.chatgptContextWindow,
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
