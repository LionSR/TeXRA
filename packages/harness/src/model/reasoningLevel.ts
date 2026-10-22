import { Effect, Result } from 'effect';
import { z } from 'zod';
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { ReasoningEffortSchema } from 'llm-zoo/schemas';

import {
  acceptedEfforts,
  BACKEND_PROTOCOLS,
  chooseReasoning,
  CODEX_ROUTE_EFFORTS,
  type BackendProviderId,
  type ModelOrigin,
  type ModelRoute,
  type ReasoningChoice,
  type ReasoningRequest,
  wireEffort,
} from '@texra-ai/llm';
import type { StateStore } from '@platform/interfaces';
import { ModelBackendSchema, type ModelBackend } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { Settings } from '@shared/config/settings';
import { ensureError } from '@utils/errors/errorMessage';

/**
 * The user's per-model reasoning effort overrides, in llm-zoo's vocabulary,
 * keyed by model reference (`provider/id`).
 *
 * This is the one boundary between the persisted `texra.reasoningLevels`
 * record and the runtime: the stored strings are parsed here, so no caller
 * carries a bare string and an entry that is not an effort is reported rather
 * than quietly disappearing. Reads only; the write path keeps the stored
 * record verbatim so an unreadable entry is never dropped from storage.
 */
export function reasoningEffortOverrides(state: StateStore) {
  return Effect.gen(function* () {
    const stored = yield* Settings.state(
      state,
      GlobalStateKey.REASONING_LEVELS,
      z.record(z.string(), z.unknown()).prefault({}),
    );
    const overrides: Record<string, ReasoningEffort> = {};
    for (const [model, value] of Object.entries(stored)) {
      const parsed = ReasoningEffortSchema.safeParse(value);
      if (parsed.success) {
        overrides[model] = parsed.data;
        continue;
      }
      // A stored value outside llm-zoo's vocabulary cannot route a request, so
      // the model falls back to its catalog default; say so rather than
      // dropping the entry silently.
      yield* Effect.logWarning(
        `Stored reasoning level ${JSON.stringify(value)} for model ${model} is not one of llm-zoo's efforts; using the model's default.`,
        parsed.error,
      );
    }
    return overrides;
  });
}

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
 * The backend a fresh run on `route` serves `config` from: the model's own
 * provider on a direct route (any credential), else the proxy that serves it.
 */
export function servingBackend(
  config: Pick<ModelConfig, 'provider'>,
  route: { readonly kind: ModelRoute['kind'] },
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

/** The route a request is bound on, as far as reasoning is concerned. */
export interface ReasoningRoute {
  readonly protocol: string;
  readonly codexSubscription: boolean;
}

/**
 * The reasoning route of a run on `backend` over the decided `route`: the
 * protocol the backend serves, and whether the Codex subscription carries
 * it. The bind, a model switch and the model options all read it here.
 */
export function reasoningRouteOf(
  route: { readonly kind: ModelRoute['kind'] },
  backend: ModelBackend,
): ReasoningRoute {
  return {
    protocol: PROTOCOL_BY_BACKEND[backend],
    codexSubscription: route.kind === 'chatgpt-subscription',
  };
}

/**
 * The model's reasoning as this route can control it. Gemini's Interactions
 * request and Kimi's Responses request have no switch that turns thinking
 * off; DashScope's has none that turns Qwen's thinking on. The policy then
 * refuses a request the route cannot carry and records what really happens.
 */
function routeReasoning(
  config: Pick<ModelConfig, 'provider' | 'reasoning'>,
  route: ReasoningRoute,
): ModelConfig['reasoning'] {
  const { reasoning } = config;
  if (reasoning === undefined) return undefined;
  const responses = route.protocol === 'openai-responses';
  if (responses && config.provider === ModelProvider.DASHSCOPE) {
    return undefined;
  }
  if (
    route.protocol === 'google-interactions' ||
    (responses && config.provider === ModelProvider.MOONSHOT)
  ) {
    return { ...reasoning, off: undefined };
  }
  return reasoning;
}

/** The levels the Codex subscription narrows a route to; none elsewhere. */
const routeCeiling = (route: ReasoningRoute) =>
  route.codexSubscription ? CODEX_ROUTE_EFFORTS : undefined;

/** {@link decideReasoning} as a value: the choice, or why it is refused. */
function chooseOnRoute(
  config: ModelConfig,
  request: ReasoningRequest,
  userEffort: ReasoningEffort | undefined,
  route: ReasoningRoute,
): Result.Result<ReasoningChoice, Error> {
  return Result.try({
    try: () =>
      chooseReasoning(
        { ...config, reasoning: routeReasoning(config, route) },
        request,
        {
          userEffort,
          routeEfforts: routeCeiling(route),
        },
      ),
    catch: ensureError,
  });
}

/**
 * The run's reasoning decision: the model string's own request, else the
 * user's saved level for the model, else the default, for the reasoning the
 * route can control; the Codex subscription narrows the levels. A level the
 * model lacks is substituted (the choice's `note` says so); a request the
 * route cannot carry fails.
 */
export function decideReasoning(
  config: ModelConfig,
  request: ReasoningRequest,
  userEffort: ReasoningEffort | undefined,
  route: ReasoningRoute,
): Effect.Effect<ReasoningChoice, Error> {
  return Effect.fromResult(chooseOnRoute(config, request, userEffort, route));
}

/** What a run sends for reasoning, or why its bind refuses the request. */
export type SentReasoning =
  | {
      /** The effort sent: `none` with thinking off, absent when the model thinks without levels. */
      readonly effort: ReasoningEffort | undefined;
      /** Why it is not the level asked for, when the policy substituted one. */
      readonly note?: string;
    }
  | { readonly refused: string };

/**
 * A model's reasoning on its decided route, as data: what the bind's own
 * policy ({@link decideReasoning}, over the inputs the bind gives it) sends,
 * so no surface words a level a run does not send.
 */
export interface RouteReasoning {
  /** The levels a run on the route can carry: those a saved level may take. */
  readonly efforts: readonly ReasoningEffort[];
  /** What a run sends under the user's saved level. */
  readonly sent: SentReasoning;
  /** What a run sends with no saved level: the route's default. */
  readonly fallback: SentReasoning;
}

/** One decision as what it sends: the wire's own effort for it. */
function sentOf(
  config: ModelConfig,
  decided: Result.Result<ReasoningChoice, Error>,
): SentReasoning {
  if (Result.isFailure(decided)) return { refused: decided.failure.message };
  const { note } = decided.success;
  const sent = wireEffort(config, decided.success) ?? undefined;
  return note === undefined ? { effort: sent } : { effort: sent, note };
}

/**
 * The reasoning a run on `route` gives `config` (the config the bind decides
 * over) under the saved level, or undefined when the model does not reason
 * there and nothing is refused. The levels offered are those of `runsWith`,
 * the config the route runs: an editor-managed Copilot route offers none.
 */
export function routeReasoningOf(input: {
  readonly config: ModelConfig;
  readonly runsWith: Pick<ModelConfig, 'provider' | 'reasoning'>;
  readonly request: ReasoningRequest;
  readonly saved: ReasoningEffort | undefined;
  readonly route: ReasoningRoute;
}): RouteReasoning | undefined {
  const { config, request, saved, route } = input;
  const sent = sentOf(config, chooseOnRoute(config, request, saved, route));
  const fallback =
    saved === undefined
      ? sent
      : sentOf(config, chooseOnRoute(config, request, undefined, route));
  const reasoning = routeReasoning(input.runsWith, route);
  if (reasoning === undefined && !('refused' in sent)) return undefined;
  const ceiling = routeCeiling(route);
  // `none` turns thinking off rather than naming a level, so no ceiling
  // applies to it (the policy's own reading).
  const efforts = acceptedEfforts({ reasoning }).filter(
    (effort) =>
      effort === ReasoningEffort.NONE ||
      ceiling === undefined ||
      ceiling.includes(effort),
  );
  return { efforts, sent, fallback };
}
