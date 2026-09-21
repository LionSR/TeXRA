// Third-party imports
import { Cause, Effect, Exit, type Scope, Stream } from 'effect';
import { Sse } from 'effect/unstable/encoding';
import { z } from 'zod';

// Local imports - canonical protocol binding
import { JsonObjectSchema } from './protocol.js';

// Local imports - canonical messages
import { MessageSchema } from './message.js';

// Local imports - canonical model errors
import { ModelError } from './errors.js';

/**
 * The server-sent events carried by a byte stream, ending at the `[DONE]`
 * sentinel that terminates an OpenAI-compatible chat stream.
 *
 * The parser is fed per decoded chunk and drained into the events it
 * completed, so an event split across chunks emits once it is whole.
 * `maxEventSize` is uncapped to preserve the prior no-added-cap policy — it
 * is not a bounded-memory claim — and a `retry` field is only a reconnect
 * hint, which these one-shot operations never act on.
 */
export const sseEvents = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
  malformedMessage: string,
): Stream.Stream<Sse.Event, E | ModelError> => {
  let parsedEvents: Sse.Event[] = [];
  const parser = Sse.makeParser(
    (event) => {
      if (event._tag === 'Event') parsedEvents.push(event);
    },
    { maxEventSize: Number.POSITIVE_INFINITY },
  );
  return bytes.pipe(
    Stream.decodeText,
    Stream.mapEffect((text) =>
      Effect.gen(function* () {
        parsedEvents = [];
        const failure = parser.feed(text);
        if (failure !== undefined)
          return yield* new ModelError({
            kind: 'malformed-output',
            message: malformedMessage,
            cause: failure,
          });
        return parsedEvents;
      }),
    ),
    Stream.flattenIterable,
    Stream.takeUntil((event) => event.data === '[DONE]'),
  );
};

/**
 * The value a pull source yields while it is not done: the `value` of the
 * not-done member of a `ReadableStreamReadResult` or `IteratorResult`. Taking
 * it from that member alone is what keeps the done member's `undefined` out
 * of the stream's element type.
 */
type PullValue<R> = R extends { done?: false; value: infer A } ? A : never;

/**
 * A stream over a pull source — a `ReadableStreamDefaultReader` or an async
 * iterator — that ends when the source reports `done`.
 *
 * Every streaming adapter reaches its provider through one of those two, and
 * each had spelled out the same `Stream.fromPull` / `tryPromise` / `done`
 * ladder. Only the source and the failure classifier ever differed, so those
 * are the parameters.
 */
export const pullStream = <
  R extends { readonly done?: boolean; readonly value?: unknown },
  E,
>(
  pull: () => PromiseLike<R>,
  onError: (cause: unknown) => E,
): Stream.Stream<PullValue<R>, E> =>
  Stream.fromPull(
    Effect.succeed(
      Effect.tryPromise({ try: () => pull(), catch: onError }).pipe(
        Effect.flatMap((next) =>
          next.done
            ? Cause.done()
            : // `done` is false here, so the result is the value-carrying
              // member of the union `PullValue` picked the type from.
              Effect.succeed([
                (next as { readonly value: PullValue<R> }).value,
              ] as const),
        ),
      ),
    ),
  );

/**
 * Parses a persisted local-call's argument text back into the JSON object a
 * provider request carries. This process authored the history, so a
 * malformed payload is our bug, not the model's: every protocol reports it
 * as `invalid-request`.
 */
export const parseOutboundToolArguments = (
  argumentsText: string,
): Effect.Effect<z.infer<typeof JsonObjectSchema>, ModelError> =>
  Effect.try({
    try: () => JsonObjectSchema.parse(JSON.parse(argumentsText)),
    catch: (cause) =>
      new ModelError({
        kind: 'invalid-request',
        message:
          'History carries local-call arguments that are not a JSON object.',
        cause,
      }),
  });

/**
 * Parses a tool call's argument text as a provider just returned it. The
 * model authored this output, so a malformed payload reports as
 * `malformed-output`; `provider` names the source in the surfaced message.
 */
export const parseInboundToolArguments = (
  argumentsText: string,
  provider: string,
): Effect.Effect<z.infer<typeof JsonObjectSchema>, ModelError> =>
  Effect.try({
    try: () => JsonObjectSchema.parse(JSON.parse(argumentsText)),
    catch: (cause) =>
      new ModelError({
        kind: 'malformed-output',
        message: `${provider} returned tool call arguments that are not a JSON object.`,
        cause,
      }),
  });

/**
 * A tool-result row translated to its Chat wire shape: OpenAI Chat and
 * OpenRouter build this identically (materialize the text parts, an error
 * status prefixes them), and diverge only in how the surrounding message is
 * typed. `callIds` is the calling assistant turn's provider call ids, in
 * `callOrdinal` order.
 */
export const chatToolResultMessages = Effect.fn('llm.chatToolResultMessages')(
  function* (
    results: Extract<
      z.infer<typeof MessageSchema>,
      { role: 'tool' }
    >['results'],
    callIds: readonly string[],
    unsupportedMessage: string,
  ) {
    const messages: { tool_call_id: string; content: string }[] = [];
    for (const result of results) {
      const text: string[] = [];
      for (const part of result.content) {
        if (part.kind !== 'text') {
          return yield* new ModelError({
            kind: 'unsupported',
            message: unsupportedMessage,
          });
        }
        text.push(part.text);
      }
      messages.push({
        // The canonical grammar already guarantees adjacent, complete ordinals.
        tool_call_id: callIds[result.callOrdinal],
        content:
          result.status === 'error' ? `Error: ${text.join('')}` : text.join(''),
      });
    }
    return messages;
  },
);

/**
 * The request signal for a streamed body, with the body reader cancelled at
 * scope close. The cancel finalizer is registered before the signal's abort
 * finalizer, so LIFO order aborts the request before cancellation joins a
 * pending read. Cancel repeats an errored reader's original failure; only that
 * repeat (the abort reason or the primary transport cause) is dropped, and
 * distinct cleanup defects stay in the scope's combined failure.
 */
export const readerAbortSignal = (
  reader: () => ReadableStreamDefaultReader<unknown> | undefined,
): Effect.Effect<AbortSignal, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer((exit) => {
      const body = reader();
      if (body === undefined) return Effect.void;
      return Effect.tryPromise({
        try: () => body.cancel(),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          (signal.aborted && cause === signal.reason) ||
          (Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof ModelError &&
                reason.error.kind === 'transport' &&
                reason.error.cause === cause,
            ))
            ? Effect.void
            : Effect.die(cause),
        ),
        Effect.ensuring(Effect.sync(() => body.releaseLock())),
      );
    });
    const signal = yield* Effect.abortSignal;
    return signal;
  });

/**
 * Run a promise-returning provider request under Effect's own abort signal,
 * rejoining the pending promise before the effect completes. On rejoin
 * failure, only the primary failure's own cause, or a caller-recognized
 * abort (`isAbortMatch`), is dropped; anything else is an independent defect.
 * `deadline`, when given, races the primary request only — rejoining always
 * waits out the pending promise so its cleanup cause is not discarded.
 */
export function ownedAbortSafeRequest<A>(
  request: (signal: AbortSignal) => Promise<A>,
  classify: (cause: unknown) => ModelError,
  options: {
    readonly isAbortMatch: (
      cause: unknown,
      signal: AbortSignal,
      exit: Exit.Exit<A, ModelError>,
    ) => boolean;
    readonly cleanupFailure?: (cause: unknown) => ModelError;
    readonly deadline?: {
      readonly duration: number;
      readonly error: ModelError;
    };
  },
): Effect.Effect<A, ModelError> {
  const { isAbortMatch, cleanupFailure = classify, deadline } = options;
  return Effect.suspend(() => {
    let started:
      | { readonly signal: AbortSignal; readonly pending: Promise<A> }
      | undefined;
    const wait = Effect.tryPromise({
      try: (signal) => {
        const pending = request(signal);
        started = { signal, pending };
        return pending;
      },
      catch: classify,
    });
    return (
      deadline === undefined
        ? wait
        : wait.pipe(
            Effect.timeoutOrElse({
              duration: deadline.duration,
              orElse: () => Effect.fail(deadline.error),
            }),
          )
    ).pipe(
      Effect.onExit((exit) => {
        if (started === undefined) return Effect.void;
        const { signal, pending } = started;
        return Effect.tryPromise({
          try: () => pending,
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => {
            const repeated =
              Exit.isFailure(exit) &&
              exit.cause.reasons.some(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  reason.error instanceof ModelError &&
                  reason.error.cause === cause,
              );
            return repeated || isAbortMatch(cause, signal, exit)
              ? Effect.void
              : Effect.die(cleanupFailure(cause));
          }),
          Effect.asVoid,
        );
      }),
    );
  });
}
