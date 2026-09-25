/**
 * The one decision of which route serves a model's next request. The picker,
 * the run binding, the compatibility key and the Copilot fallback all read
 * {@link decideModelRoute} over the same {@link RouteFacts}, and carry the
 * decided {@link ModelRoute} instead of re-asking any of its questions.
 *
 * The decision is pure. Its host facts are read once by
 * {@link readRouteFacts}; the per-call facts (the validation override, the
 * Copilot preference, a resumed conversation's format) are the caller's.
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
 *    "Prefer Kimi Code" on and a Kimi Code key stored, and their wire ID
 *    differs (`kimi-k3` becomes `k3`, see {@link KIMI_CODE_WIRE_MODEL_IDS}).
 */
import { Effect } from 'effect';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  isCodexSignedIn,
  isPreferCodexSubscription,
} from '@model/codex/codexSubscription';
import {
  isPreferXaiSubscription,
  isXaiSignedIn,
} from '@model/xai/xaiSubscription';
import { StateReadFailed } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  type DeclinableUsageRoute,
} from '@shared/schemas';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import {
  getGLMCodingPlan,
  getPreferKimiCode,
  getProviderEndpoint,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

import {
  hasUsableApiKey,
  isApiProvider,
  type ApiProvider,
} from './apiProviders';
import {
  isOpenRouterRoutingUnsupported,
  shouldRouteModelThroughOpenRouter,
} from './openRouterRouting';
import { zeroCostAccessOverrides } from './subscriptionAccessOverrides';

/** The facts one route decision reads, and nothing else. */
export interface RouteFacts {
  /** A guarded package-validation run: every model binds the validation model. */
  readonly validation: boolean;
  /** The user asked the editor (Copilot) to serve this model. */
  readonly prefersCopilot: boolean;
  /** The OpenRouter choice: the live toggle, or a resumed format's. */
  readonly useOpenRouter: boolean;
  /** ChatGPT subscription preferred, signed in, and not declined. */
  readonly chatgptSubscription: boolean;
  /** Grok subscription preferred, signed in, and not declined. */
  readonly xaiSubscription: boolean;
  /** A Kimi Code console key is stored. */
  readonly kimiCodeKey: boolean;
  /** "Prefer Kimi Code" is on and not declined. */
  readonly preferKimiCode: boolean;
  /** The GLM Coding Plan is on, not declined, and no dashboard GLM endpoint
   *  outranks its path. */
  readonly glmCodingPlan: boolean;
}

/** The facts under which a model takes its own key: no preference is on. */
export const OWN_KEY_ROUTE_FACTS: RouteFacts = {
  validation: false,
  prefersCopilot: false,
  useOpenRouter: false,
  chatgptSubscription: false,
  xaiSubscription: false,
  kimiCodeKey: false,
  preferKimiCode: false,
  glmCodingPlan: false,
};

/** The host half of {@link RouteFacts}, shared by every model. */
export type HostRouteFacts = Omit<RouteFacts, 'validation' | 'prefersCopilot'>;

/** What a direct provider key pays through. */
type ApiKeyUsageRoute =
  'api-key' | 'kimi-code-subscription' | 'glm-coding-plan-subscription';

/** The route a model's next request takes, decided by {@link decideModelRoute}. */
export type ModelRoute =
  | { readonly kind: 'validation' }
  | { readonly kind: 'copilot' }
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
export function decideModelRoute(
  config: ModelConfig,
  facts: RouteFacts,
): ModelRoute {
  if (facts.validation) return { kind: 'validation' };
  // Editor-supplied models cannot be proxied through OpenRouter, and a
  // preference is a hard route choice (#9635).
  if (facts.prefersCopilot || config.provider === ModelProvider.COPILOT) {
    return { kind: 'copilot' };
  }
  if (isOpenRouterRoutingUnsupported(config, facts.useOpenRouter)) {
    return { kind: 'openrouter-unsupported' };
  }
  // The subscriptions are preferences: signed out, the model takes its key.
  if (
    facts.chatgptSubscription &&
    !facts.useOpenRouter &&
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
  // A per-model base URL outranks the plan's path (`@model/routeEndpoint`).
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
 * Read the host half of the route facts. `declinedRoutes` are the routes the
 * asking run declined (a retry the user answered with their own key): a
 * declined subscription reads as off for that run without touching the
 * user's preference. An unreadable Kimi Code key reads as absent and warns,
 * the rule the picker applies to every key status.
 */
export const readRouteFacts = Effect.fn('readRouteFacts')(function* (
  stores: SettingsStores & { readonly secrets: PlatformSecrets },
  declinedRoutes: readonly DeclinableUsageRoute[] = [],
): Effect.fn.Return<HostRouteFacts, StateReadFailed> {
  const allowed = (route: DeclinableUsageRoute) =>
    !declinedRoutes.includes(route);
  // Only worth a sign-in probe when the preference is on. The preference read
  // is a synchronous catalog read that throws; keep it in the typed channel.
  const subscriptionOn = (
    route: DeclinableUsageRoute,
    preference: string,
    isPrefer: (stores: SettingsStores) => boolean,
    isSignedIn: () => Effect.Effect<boolean>,
  ) =>
    allowed(route)
      ? Effect.try({
          try: () => isPrefer(stores),
          catch: (cause) =>
            new StateReadFailed({
              key: preference,
              message: `Could not read the ${preference} preference.`,
              cause,
            }),
        }).pipe(
          Effect.flatMap((on) => (on ? isSignedIn() : Effect.succeed(false))),
        )
      : Effect.succeed(false);
  const [
    useOpenRouter,
    preferKimiCode,
    glmCodingPlan,
    glmEndpoint,
    chatgptSubscription,
    xaiSubscription,
    kimiCodeKey,
  ] = yield* Effect.all(
    [
      getUseOpenRouter(stores),
      getPreferKimiCode(stores),
      getGLMCodingPlan(stores),
      getProviderEndpoint(stores, ModelProvider.GLM),
      subscriptionOn(
        'chatgpt-subscription',
        'ChatGPT subscription',
        isPreferCodexSubscription,
        isCodexSignedIn,
      ),
      subscriptionOn(
        'xai-subscription',
        'Grok subscription',
        isPreferXaiSubscription,
        isXaiSignedIn,
      ),
      hasUsableApiKey(stores.secrets, 'kimiCode').pipe(
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.logWarning(
            'Failed to read Kimi Code API key status; treating it as unavailable.',
            failure.cause,
          ).pipe(Effect.as(false)),
        ),
      ),
    ] as const,
    { concurrency: 'unbounded' },
  );
  return {
    useOpenRouter,
    chatgptSubscription,
    xaiSubscription,
    kimiCodeKey,
    preferKimiCode: preferKimiCode && allowed('kimi-code-subscription'),
    glmCodingPlan:
      glmCodingPlan && !glmEndpoint && allowed('glm-coding-plan-subscription'),
  };
});

/**
 * Open-platform `fullName` to coding-endpoint wire ID. Exclusive plan aliases
 * already use their wire ID as `fullName` and pass through unchanged.
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
 * route itself names the credential and endpoint (`@model/routeEndpoint`).
 */
export const routeConfig = Effect.fn('routeConfig')(function* (
  stores: SettingsStores,
  config: ModelConfig,
  route: ModelRoute,
): Effect.fn.Return<ModelConfig, StateReadFailed> {
  switch (route.kind) {
    case 'chatgpt-subscription': {
      // The setting is stored in thousands of tokens; this is its only
      // reader, so the unit conversion lives here and nowhere else.
      const inputTokenLimit = Math.min(
        (yield* readSettingFrom<number>(
          stores,
          CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey,
        )) * CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit,
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
      const wireId =
        KIMI_CODE_WIRE_MODEL_IDS[config.fullName] ?? config.fullName;
      return {
        ...config,
        fullName: wireId,
        shortName: wireId,
        ...zeroCostAccessOverrides(
          Math.min(KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW, config.contextWindow),
        ),
      };
    }
    default:
      return config;
  }
});
