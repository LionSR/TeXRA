/**
 * Which route serves a model: llm's pure `decideModelRoute` over the facts
 * one {@link ModelSettings} read holds, the editor's Copilot route where the
 * decision can land on it, and a resumed run's backend, which constrains the
 * decision so a preference turned on since never moves its billing. Also
 * whether a model switch can take the run's route, and the one move onto the
 * user's own credential a failed attempt offers.
 */
import { Effect } from 'effect';
import { ModelProvider, type ModelConfig, type ReasoningMode } from 'llm-zoo';

import {
  BACKEND_PROTOCOLS,
  decideModelRoute,
  hasUsableApiKey,
  OWN_KEY_ROUTE_FACTS,
  type BackendProviderId,
  type HostRouteFacts,
  type ModelOrigin,
  type ModelRoute,
  type SelectedModel,
} from '@texra-ai/llm';

import { shouldUseInternalValidationModel } from '@agent/runtime/run/validationModel';
import { RouteUnavailable } from '@common/errors/agentErrors';
import {
  copilotRouteUnavailableReason,
  discoverCopilotRoutes,
  type CopilotModelRoute,
} from '@model/copilotRouting';
import { routeFactsFor, type ModelSettings } from '@model/modelSettings';
import { decideReasoning } from '@model/reasoningLevel';
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import {
  getExhaustionReason,
  ModelBackendSchema,
  type CredentialSwitch,
  type DeclinableUsageRoute,
  type ModelBackend,
  type ProviderError,
} from '@shared/schemas';

/** The protocol each backend serves a run on. */
export const PROTOCOL_BY_BACKEND: Readonly<
  Record<ModelBackend, ModelOrigin['protocol'] | 'validation'>
> = Object.freeze({ validation: 'validation', ...BACKEND_PROTOCOLS });

type AssertNever<T extends never> = T;
/** Every plugin that names a protocol is a stored backend. */
type _EveryBackendProviderIsStored = AssertNever<
  Exclude<BackendProviderId, ModelBackend>
>;

/**
 * The routes a binding can take: the unsupported one fails in the decision,
 * and a Copilot route binds only with the editor route discovered for it.
 */
type BindableRoute =
  | Exclude<
      ModelRoute<CopilotModelRoute>,
      { kind: 'openrouter-unsupported' | 'copilot' }
    >
  | { readonly kind: 'copilot'; readonly route: CopilotModelRoute };

/** What one route decision found. */
export interface RouteDecision {
  readonly route: BindableRoute;
  /** The facts it was decided over; the binding reads endpoints and windows off them. */
  readonly facts: HostRouteFacts;
  /** The backend the route serves the model from. */
  readonly backend: ModelBackend;
}

/** What the decision is asked for besides the model. */
export interface RouteAsk {
  /** A resumed run's backend; it wins over today's default route. */
  readonly backend?: ModelBackend;
  /** Own-key quota fallback also declines the Copilot preference. */
  readonly ownApiKeyFallback?: boolean;
  /** The routes the run declined (its rows record them). */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /** The provider reasoning mode the request asks for (OpenAI `pro`). */
  readonly mode?: ReasoningMode;
}

/** The backend `route` serves `config` from: the model's own provider on a
 *  direct route (any credential), else the proxy that serves it. */
function servingBackend(
  config: ModelConfig,
  route: BindableRoute,
): ModelBackend | undefined {
  switch (route.kind) {
    case 'validation':
      return 'validation';
    case 'copilot':
      return 'copilot';
    case 'openrouter':
      return 'openRouter';
    default:
      return ModelBackendSchema.safeParse(config.provider).data;
  }
}

const unavailable = (message: string, cause?: unknown) =>
  new RouteUnavailable({ reason: 'unavailable', message, cause });

/**
 * Decide the route `config` binds under. A resumed conversation's backend
 * constrains the facts: its OpenRouter, Copilot and validation choice are
 * the backend's, and a subscription serves it only from its own provider.
 * When the decision can land on Copilot, the editor's routes are discovered
 * here, once. The routes nothing can bind fail as the user's instruction.
 */
export const decideRoute = Effect.fn('decideRoute')(function* (
  config: ModelConfig,
  settings: ModelSettings,
  ask: RouteAsk,
): Effect.fn.Return<RouteDecision, RouteUnavailable, LanguageModel> {
  const host = routeFactsFor(settings, ask.declinedRoutes);
  const { backend, mode } = ask;
  const prefersCopilot =
    backend === undefined
      ? !ask.ownApiKeyFallback && settings.copilotModels.includes(config.ref)
      : backend === 'copilot';
  // A provider mode never takes the Copilot preference, so the editor is not
  // asked for a route it would not use.
  const copilotRoute =
    (prefersCopilot && mode === undefined) ||
    config.provider === ModelProvider.COPILOT
      ? (yield* discoverCopilotRoutes().pipe(
          Effect.mapError((cause) =>
            unavailable(
              `Could not list the editor's models: ${cause.message}`,
              cause,
            ),
          ),
        )).get(config.ref)
      : undefined;
  const decided = decideModelRoute(
    config,
    backend === undefined
      ? {
          ...host,
          validation: yield* shouldUseInternalValidationModel(),
          prefersCopilot,
          copilotRoute,
          mode,
        }
      : {
          ...host,
          validation: backend === 'validation',
          prefersCopilot,
          copilotRoute,
          useOpenRouter: backend === 'openRouter',
          chatgptSubscription: host.chatgptSubscription && backend === 'openai',
          xaiSubscription: host.xaiSubscription && backend === 'xai',
          mode,
        },
  );
  if (decided.kind === 'openrouter-unsupported') {
    return yield* unavailable(
      `${config.label} in ${mode} mode is not served by OpenRouter. Disable OpenRouter and use the provider API directly.`,
    );
  }
  let route: BindableRoute;
  if (decided.kind === 'copilot') {
    // A fresh run needs the editor to allow the route; a resumed
    // conversation keeps its backend and binds whatever route it offers.
    const refused =
      backend === undefined
        ? copilotRouteUnavailableReason(config.ref, decided.route)
        : undefined;
    if (refused) return yield* unavailable(refused);
    if (decided.route === undefined) {
      return yield* unavailable(
        `No editor offers ${config.label} through Copilot now: Copilot models run through a VS Code window of this project with GitHub Copilot, and none is open or none offers this model. Open the project in VS Code, or turn off Copilot for this model.`,
      );
    }
    route = { kind: 'copilot', route: decided.route };
  } else {
    route = decided;
  }
  const served = servingBackend(config, route);
  if (served === undefined) {
    return yield* unavailable(`Unsupported model provider: ${config.provider}`);
  }
  return { route, facts: host, backend: served };
});

/** Why a model cannot replace a run's: a short reason, and the error's sentence. */
export interface SwitchRefusal {
  readonly reason: string;
  readonly message: string;
}

const DIFFERENT_FORMAT: SwitchRefusal = {
  reason: 'different conversation format; start new chat',
  message:
    'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.',
};

/**
 * Why `selected` cannot replace a run on `backend`, decided as the bind at
 * the run's next model boundary will decide it; null when it can. A
 * reasoning request the route cannot carry (`@none` on a model that always
 * thinks) is refused here, not by that bind inside the loop.
 */
export const admitSwitch = Effect.fn('admitSwitch')(function* (
  selected: SelectedModel,
  backend: ModelBackend,
  settings: ModelSettings,
  declinedRoutes: readonly DeclinableUsageRoute[],
): Effect.fn.Return<SwitchRefusal | null, RouteUnavailable, LanguageModel> {
  const decision = yield* decideRoute(selected.config, settings, {
    backend,
    declinedRoutes,
    mode: selected.request.mode,
  });
  if (decision.backend !== backend) return DIFFERENT_FORMAT;
  return yield* decideReasoning(
    selected.config,
    selected.request,
    settings.reasoningLevels[selected.config.ref],
    {
      protocol: PROTOCOL_BY_BACKEND[backend],
      codexSubscription: decision.route.kind === 'chatgpt-subscription',
    },
  ).pipe(
    Effect.as(null),
    Effect.catch((error) =>
      Effect.succeed({ reason: error.message, message: error.message }),
    ),
  );
});

/** The routes whose quota the retry owner falls back from without asking. */
const CODING_PLAN_ROUTES: readonly DeclinableUsageRoute[] = [
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
];

/**
 * The move onto the user's own credential a failed attempt offers, carried
 * on the retry request so no host re-derives it.
 *
 * - A subscription or coding-plan route falls back to the route the model
 *   takes with every preference off, unless that is the same kind of route.
 * - A key whose upstream account ran out of credit needs a changed key.
 * - The Copilot route moves to a replacement run on the direct model.
 *
 * A coding-plan fallback is automatic when its key is already stored and the
 * run has not declined that route before; the subscriptions (ChatGPT, Grok)
 * stay explicit, because moving them onto a key starts spending API credit.
 */
export const credentialSwitch = Effect.fn('credentialSwitch')(function* (
  failed: { readonly config: ModelConfig; readonly route: ModelRoute },
  recorded: Pick<ProviderError, 'classification'>,
  declinedRoutes: readonly DeclinableUsageRoute[],
  secrets: PlatformSecrets,
): Effect.fn.Return<CredentialSwitch | null> {
  const reason = getExhaustionReason(recorded);
  if (reason === undefined) return null;
  const { route } = failed;
  let declined: DeclinableUsageRoute;
  switch (route.kind) {
    case 'copilot':
      return reason === 'copilot-subscription'
        ? { kind: 'copilot-fallback' }
        : null;
    case 'openrouter':
      return reason === 'upstream-credit'
        ? { kind: 'new-key', provider: 'openRouter' }
        : null;
    case 'chatgpt-subscription':
    case 'xai-subscription':
      declined = route.kind;
      break;
    case 'api-key':
      // The key the route bound is itself the broken credential.
      if (reason === 'upstream-credit') {
        return { kind: 'new-key', provider: route.provider };
      }
      if (route.usageRoute === 'api-key') return null;
      declined = route.usageRoute;
      break;
    default:
      return null;
  }
  const fallback = decideModelRoute(failed.config, OWN_KEY_ROUTE_FACTS);
  if (fallback.kind !== 'api-key' || fallback.usageRoute !== 'api-key') {
    return null;
  }
  const automatic =
    CODING_PLAN_ROUTES.includes(declined) &&
    !declinedRoutes.includes(declined) &&
    (yield* hasUsableApiKey(secrets, fallback.provider).pipe(
      Effect.catchTag('SecretsFailed', (failure) =>
        Effect.logWarning(
          `Could not read the ${fallback.provider} API key; the quota fallback waits for a decision.`,
          failure.cause,
        ).pipe(Effect.as(false)),
      ),
    ));
  return {
    kind: 'decline-route',
    route: declined,
    provider: fallback.provider,
    automatic,
  };
});
