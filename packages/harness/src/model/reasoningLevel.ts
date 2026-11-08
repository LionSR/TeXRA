import { Effect, Result, Schema } from 'effect';

import {
  acceptedEfforts,
  BACKEND_PROTOCOLS,
  type BackendProviderId,
  chooseReasoning,
  type ModelConfig,
  type ModelOrigin,
  type ModelRoute,
  type ReasoningChoice,
  type ReasoningChoiceError,
  ReasoningEffort,
  ReasoningEffortSchema,
  type ReasoningRequest,
  wireEffort,
} from '@texra-ai/llm';
import { Settings, type StateStore } from '@shared/config/settings';
import { ModelBackendSchema, type ModelBackend } from '@shared/schemas';
import type { StateKey } from '@shared/state/stateSettings';

/**
 * The user's per-model reasoning effort overrides, in llm-zoo's vocabulary,
 * keyed by model reference (`provider/id`).
 *
 * This is the one boundary between the persisted `reasoningLevels`
 * record and the runtime: the stored strings are parsed here, so no caller
 * carries a bare string and an entry that is not an effort is reported rather
 * than quietly disappearing. Reads only; the write path keeps the stored
 * record verbatim so an unreadable entry is never dropped from storage.
 */
/**
 * The user's saved reasoning effort per model reference. Its entries stay
 * unparsed in the record so a write keeps every entry, readable or not.
 */
export const REASONING_LEVELS_KEY = {
  key: 'reasoningLevels',
  slot: 'globalState',
  schema: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
} as const satisfies StateKey<Readonly<Record<string, unknown>>>;

export const reasoningEffortOverrides = Effect.fn('reasoningEffortOverrides')(
  function* (state: StateStore) {
    const stored = yield* Settings.state(state, REASONING_LEVELS_KEY);
    const overrides: Record<string, ReasoningEffort> = {};
    for (const [model, value] of Object.entries(stored)) {
      const parsed = Schema.decodeUnknownResult(ReasoningEffortSchema)(value);
      if (Result.isSuccess(parsed)) {
        overrides[model] = parsed.success;
        continue;
      }
      // A stored value outside llm-zoo's vocabulary cannot route a request, so
      // the model falls back to its catalog default; say so rather than
      // dropping the entry silently.
      yield* Effect.logWarning(
        `Stored reasoning level ${JSON.stringify(value)} for model ${model} is not one of llm-zoo's efforts; using the model's default.`,
        parsed.failure,
      );
    }
    return overrides;
  },
);

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
 * The backend a fresh run serves `config` from off the validation model: the
 * model's own provider, whatever credential its route bills.
 */
export function servingBackend(
  config: Pick<ModelConfig, 'provider'>,
): ModelBackend | undefined {
  return Result.getOrUndefined(
    Schema.decodeUnknownResult(ModelBackendSchema)(config.provider),
  );
}

/**
 * The route a run's reasoning is decided on. The validation model carries
 * every control the model has, so it names no llm route.
 */
type ReasoningRoute = ModelRoute | { readonly kind: 'validation' };

const llmRoute = (route: ReasoningRoute) =>
  route.kind === 'validation' ? undefined : route;

/** {@link decideReasoning} as a value: the choice, or why it is refused. */
const chooseOnRoute = (
  config: ModelConfig,
  request: ReasoningRequest,
  userEffort: ReasoningEffort | undefined,
  route: ReasoningRoute,
) => chooseReasoning(config, request, { userEffort, route: llmRoute(route) });

/**
 * The run's reasoning decision: the model string's own request, else the
 * user's saved level for the model, else the default, for the reasoning the
 * route can control (`chooseReasoning`'s route rules). A level the model
 * lacks is substituted (the choice's `note` says so); a request the route
 * cannot carry fails.
 */
export function decideReasoning(
  config: ModelConfig,
  request: ReasoningRequest,
  userEffort: ReasoningEffort | undefined,
  route: ReasoningRoute,
): Effect.Effect<ReasoningChoice, ReasoningChoiceError> {
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
  route: ReasoningRoute,
  decided: Result.Result<ReasoningChoice, ReasoningChoiceError>,
): SentReasoning {
  if (Result.isFailure(decided)) return { refused: decided.failure.message };
  const { note } = decided.success;
  const sent =
    wireEffort(config, llmRoute(route), decided.success) ?? undefined;
  return note === undefined ? { effort: sent } : { effort: sent, note };
}

/**
 * The reasoning a run on `route` gives `config` (the config the bind decides
 * over) under the saved level, or undefined when the model does not reason
 * there and nothing is refused.
 */
export function routeReasoningOf(input: {
  readonly config: ModelConfig;
  readonly request: ReasoningRequest;
  readonly saved: ReasoningEffort | undefined;
  readonly route: ReasoningRoute;
}): RouteReasoning | undefined {
  const { config, request, saved, route } = input;
  const chosen = chooseOnRoute(config, request, saved, route);
  const sent = sentOf(config, route, chosen);
  const fallback =
    saved === undefined
      ? sent
      : sentOf(config, route, chooseOnRoute(config, request, undefined, route));
  const efforts = acceptedEfforts(config, llmRoute(route));
  // The model does not reason on the route: no level, and no thinking.
  if (
    efforts.length === 0 &&
    Result.isSuccess(chosen) &&
    !chosen.success.thinking
  ) {
    return undefined;
  }
  return { efforts, sent, fallback };
}
