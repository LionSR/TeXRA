// Third-party imports
import {
  Clock,
  Duration,
  Effect,
  Predicate,
  Ref,
  Result,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from 'effect';

// Local imports - canonical model contract
import { sameModelOrigin, type ModelOrigin } from '../protocol.js';
import {
  BackgroundEventSchema,
  BackgroundSubmissionSchema,
  ObservationPolicySchema,
  type BackgroundEvent,
  type Model,
  type ResolvedTurn,
  type TurnResult,
} from '../turn.js';
import {
  fillModelError,
  ModelError,
  RemoteOperationSchema,
  type ModelErrorFields,
  type RemoteOperation,
} from '../errors.js';

/** `turn`, provided it is a background turn from the `origin` binding. */
function admitTurn<P extends ResolvedTurn['protocol']>(
  turn: ResolvedTurn,
  origin: ModelOrigin & { readonly protocol: P },
): Effect.Effect<
  Extract<ResolvedTurn, { protocol: P; mode: 'background' }>,
  ModelError
> {
  // The origin comparison includes the protocol.
  const admitted = (
    candidate: ResolvedTurn,
  ): candidate is Extract<ResolvedTurn, { protocol: P; mode: 'background' }> =>
    candidate.mode === 'background' && sameModelOrigin(candidate, origin);
  return admitted(turn)
    ? Effect.succeed(turn)
    : Effect.fail(
        new ModelError({
          kind: 'unsupported',
          message: 'The admitted turn belongs to another model binding.',
        }),
      );
}

/** The operation `input` names, provided it belongs to the `origin` binding. */
const boundOperation = Effect.fn('llm.boundOperation')(function* (
  input: RemoteOperation,
  origin: ModelOrigin,
) {
  const parsed = Schema.decodeUnknownResult(RemoteOperationSchema)(input);
  if (
    !Result.isSuccess(parsed) ||
    !sameModelOrigin(parsed.success.origin, origin)
  )
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The remote operation belongs to another model binding.',
    });
  return parsed.success;
});

/** A failure filled with what the call learned, the requested model standing in for a returned one. */
const filled =
  (learned: Ref.Ref<Partial<ModelErrorFields>>, origin: ModelOrigin) =>
  (error: ModelError): ModelError => {
    const known = Ref.getUnsafe(learned);
    return fillModelError(error, {
      ...known,
      responseId: known.operation?.providerResponseId,
      model: known.model ?? origin.requestedModel,
    });
  };

/**
 * A cancel reply's status, read as the one fact a caller acts on: only
 * `cancelled` confirms the work stopped. Any other status (still queued or
 * running, or a terminal outcome reached first) leaves the operation
 * observable, so it fails rather than let the caller retire it.
 */
const confirmCancelled = (
  operation: RemoteOperation,
  status: string,
): Effect.Effect<void, ModelError> =>
  status === 'cancelled'
    ? Effect.void
    : Effect.fail(
        new ModelError({
          kind: 'provider-rejection',
          retryable: false,
          message: `The background response ${operation.providerResponseId} was not cancelled; it is ${status}.`,
        }),
      );

/**
 * The `background` member over one provider's wire. `submit` sends the turn
 * and returns its result when the work already finished; `observe` polls a
 * snapshot (undefined while the work runs) or streams the events; `cancel`
 * returns the status the provider reports; `finalize` anchors a completed
 * result's continuation. Each records what it learns from the provider in
 * `learned`, and every failure is filled from it.
 *
 * Interrupting a call stops only its local request. It never cancels the
 * remote work, whose receipt may not have been delivered yet.
 */
export function backgroundLifecycle<
  P extends 'openai-responses' | 'google-interactions',
>(wire: {
  readonly origin: ModelOrigin & { readonly protocol: P };
  readonly submit: (
    turn: Extract<ResolvedTurn, { protocol: P; mode: 'background' }>,
    learned: Ref.Ref<Partial<ModelErrorFields>>,
  ) => Effect.Effect<TurnResult | undefined, ModelError, Scope.Scope>;
  readonly observe:
    | {
        readonly poll: (
          operation: RemoteOperation,
          learned: Ref.Ref<Partial<ModelErrorFields>>,
        ) => Effect.Effect<TurnResult | undefined, ModelError>;
      }
    | {
        readonly stream: (
          operation: RemoteOperation,
          learned: Ref.Ref<Partial<ModelErrorFields>>,
        ) => Stream.Stream<BackgroundEvent, ModelError>;
      };
  readonly cancel: (
    operation: RemoteOperation,
    learned: Ref.Ref<Partial<ModelErrorFields>>,
  ) => Effect.Effect<string, ModelError, Scope.Scope>;
  readonly finalize: (
    turn: Extract<ResolvedTurn, { protocol: P; mode: 'background' }>,
    result: TurnResult,
  ) => Effect.Effect<TurnResult, ModelError>;
}): NonNullable<Model['background']> {
  const { origin } = wire;

  const submit = Effect.fn('llm.background.submit')(function* (
    input: ResolvedTurn,
  ) {
    const turn = yield* admitTurn(input, origin);
    const learned = yield* Ref.make<Partial<ModelErrorFields>>({});
    return yield* Effect.scoped(wire.submit(turn, learned)).pipe(
      Effect.flatMap((result) =>
        result === undefined
          ? Effect.map(Ref.get(learned), ({ operation, model }) =>
              Schema.decodeUnknownSync(BackgroundSubmissionSchema)({
                kind: 'accepted',
                operation,
                returnedModel: model ?? null,
              }),
            )
          : Effect.map(wire.finalize(turn, result), (completed) => ({
              kind: 'completed' as const,
              result: completed,
            })),
      ),
      Effect.mapError(filled(learned, origin)),
    );
  });

  const observe: NonNullable<Model['background']>['observe'] = (
    input,
    claimed,
    policy,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const turn = yield* admitTurn(input, origin);
        const operation = yield* boundOperation(claimed, origin);
        const learned = yield* Ref.make<Partial<ModelErrorFields>>({
          operation,
        });
        const parsed = Schema.decodeUnknownResult(ObservationPolicySchema)(
          policy,
        );
        if (!Result.isSuccess(parsed))
          return yield* new ModelError({
            kind: 'invalid-request',
            message: 'The observation deadline is invalid.',
            cause: parsed.failure,
            operation,
          });
        // Consumer delay and earlier observations consume the original deadline.
        const remaining = Duration.millis(
          parsed.success.deadlineAtMs - (yield* Clock.currentTimeMillis),
        );
        const deadline = new ModelError({
          kind: 'observation-deadline',
          message: 'The original observation deadline has expired.',
        });
        if (!Duration.isPositive(remaining))
          return yield* filled(learned, origin)(deadline);
        const events =
          'poll' in wire.observe
            ? Stream.concat(
                Stream.succeed(
                  Schema.decodeUnknownSync(BackgroundEventSchema)({
                    kind: 'identified',
                    afterSequence: null,
                    providerResponseId: operation.providerResponseId,
                    requestedOrigin: origin,
                    returnedModel: null,
                  }),
                ),
                Stream.fromEffect(
                  Effect.repeat(wire.observe.poll(operation, learned), {
                    schedule: Schedule.spaced('5 seconds'),
                    until: Predicate.isNotUndefined,
                  }),
                ).pipe(
                  // The repeat ends only on the snapshot of finished work.
                  Stream.filter(Predicate.isNotUndefined),
                  Stream.map((result): BackgroundEvent => ({
                    kind: 'completed',
                    afterSequence: null,
                    result,
                  })),
                ),
              )
            : wire.observe.stream(operation, learned);
        return events.pipe(
          Stream.mapEffect(
            (event): Effect.Effect<BackgroundEvent, ModelError> =>
              event.kind === 'completed'
                ? Effect.map(wire.finalize(turn, event.result), (result) => ({
                    ...event,
                    result,
                  }))
                : Effect.succeed(event),
          ),
          Stream.interruptWhen(
            Effect.sleep(remaining).pipe(Effect.andThen(Effect.fail(deadline))),
          ),
          Stream.mapError(filled(learned, origin)),
        );
      }),
    );

  const cancel = Effect.fn('llm.background.cancel')(function* (
    input: RemoteOperation,
  ) {
    const operation = yield* boundOperation(input, origin);
    const learned = yield* Ref.make<Partial<ModelErrorFields>>({ operation });
    return yield* Effect.scoped(wire.cancel(operation, learned)).pipe(
      Effect.flatMap((status) => confirmCancelled(operation, status)),
      Effect.mapError(filled(learned, origin)),
    );
  });

  return Object.freeze({ submit, observe, cancel });
}
