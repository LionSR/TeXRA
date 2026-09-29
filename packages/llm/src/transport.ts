// Third-party imports
import { Cause, Effect, Exit, type Scope, Stream } from 'effect';
import { z } from 'zod';

// Local imports - canonical protocol binding
import { JsonObjectSchema } from './protocol.js';

// Local imports - canonical messages
import { MessageSchema } from './message.js';

// Local imports - canonical model errors
import { ModelError } from './errors.js';

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
 * A stream over a foreign SDK's async iterator, which the scope closes: the
 * request aborts first, since a queued `return` cannot release a pending SDK
 * read until then. A rejected `return` is a defect, raised through
 * `cleanupFailure`.
 */
export const sdkStream = Effect.fn('llm.sdkStream')(function* <E>(
  source: AsyncIterable<unknown> & { readonly controller: AbortController },
  onError: (cause: unknown) => E,
  cleanupFailure: (cause: unknown) => unknown = (cause) => cause,
) {
  const iterator = yield* Effect.acquireRelease(
    Effect.sync(() => source[Symbol.asyncIterator]()),
    (iterator) => {
      source.controller.abort();
      return iterator.return
        ? Effect.tryPromise({
            try: () => iterator.return!(),
            catch: cleanupFailure,
          }).pipe(Effect.orDie)
        : Effect.void;
    },
  );
  return pullStream(() => iterator.next(), onError);
});

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
 * A tool-result row translated to OpenRouter's Chat wire shape: the text
 * parts materialized, an error status prefixing them. `callIds` is the
 * calling assistant turn's provider call ids, in `callOrdinal` order.
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
 * Waits out `pending` at scope close. A rejection is dropped only when it
 * repeats the cause the primary failure in `exit` already carries, or when
 * `isExpected` recognizes it; anything else is an independent defect, raised
 * through `cleanupFailure`.
 */
export const rejoin = (
  pending: PromiseLike<unknown>,
  exit: Exit.Exit<unknown, unknown>,
  isExpected: (cause: unknown) => boolean,
  cleanupFailure: (cause: unknown) => unknown = (cause) => cause,
): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => pending, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      isExpected(cause) ||
      (Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) =>
            Cause.isFailReason(reason) &&
            reason.error instanceof ModelError &&
            reason.error.cause === cause,
        ))
        ? Effect.void
        : Effect.die(cleanupFailure(cause)),
    ),
    Effect.asVoid,
  );

/**
 * The request signal for a streamed body, with the body reader cancelled at
 * scope close. The cancel finalizer is registered before the signal's abort
 * finalizer, so LIFO order aborts the request before cancellation joins a
 * pending read. Cancel repeats an errored reader's original failure; only that
 * repeat (the abort reason, or the cause the primary failure already carries,
 * such as a transport error or a parser's rejection of a streamed event) is
 * dropped, and distinct cleanup defects stay in the scope's combined failure.
 */
export const readerAbortSignal = (
  reader: () => ReadableStreamDefaultReader<unknown> | undefined,
): Effect.Effect<AbortSignal, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer((exit) => {
      const body = reader();
      if (body === undefined) return Effect.void;
      return rejoin(
        body.cancel(),
        exit,
        (cause) => signal.aborted && cause === signal.reason,
      ).pipe(Effect.ensuring(Effect.sync(() => body.releaseLock())));
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
        return rejoin(
          pending,
          exit,
          (cause) => isAbortMatch(cause, signal, exit),
          cleanupFailure,
        );
      }),
    );
  });
}
