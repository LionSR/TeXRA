/**
 * One completed model call outside a turn: a compaction summary, on its
 * run's binding, or a helper call (a session description, a draft polish),
 * on its own. It runs the one retry loop (`invocation.ts`) and keeps its
 * invocation in memory, folded from the rows it records, since no loop
 * continues from them: a summary records its attempts on its run's history,
 * a helper call belongs to none and records nothing.
 */
import { Clock, Effect, Ref, Result } from 'effect';
import {
  completedTurn,
  type ResolvedTurn,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm';

import type { AgentTrace } from '@agent/trace';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type {
  FailedNext,
  InvocationRef,
  NormalizedUsage,
  RetryErrorInfo,
} from '@shared/schemas';
import { invocationAfter, type Invocation } from '@shared/session/inFlight';
import { UsageLog } from '@shared/usageLog';
import { sha256 } from '@utils/core/idHash';

import { runInvocation } from './invocation';
import { AttemptFailed, classifyModelFailure } from './modelFailure';
import { priceTurnUsage, reportUsage, type UsageAttribution } from './pricing';
import type { HttpClient } from 'effect/http';
import type { ModelRetryGate } from '../ModelRetryGate';
import type { BoundModel } from './modelBinding';

/** A completed call and its priced usage (`null`: none reported). */
export interface CallResult {
  readonly turn: TurnResult;
  readonly usage: NormalizedUsage | null;
}

export interface ModelCall<R = never> {
  /** Why the call is made; a turn is `ModelInvoker.invoke`, not this path. */
  readonly purpose: 'compaction' | 'helper';
  /** The binding in force, read again before every attempt. */
  readonly binding: Effect.Effect<BoundModel>;
  /** Replace a binding a failure killed or a refresh renewed. */
  readonly reacquire: (failed: BoundModel) => Effect.Effect<unknown, never, R>;
  /** A foreground request; each attempt prepares it on its binding. */
  readonly request: TurnRequest;
  /** The process's retry gate: every call on one credential shares it. */
  readonly gate: ModelRetryGate;
  /** The session's settings: usage consent reads them. */
  readonly settings: SettingsStores;
  readonly secrets: PlatformSecrets;
  readonly attribution: UsageAttribution;
  /** Automatic retries; the binding's when absent. */
  readonly retries?: number;
  /** A run's trace; without one, diagnostics go to the Effect logger. */
  readonly logger: Pick<AgentTrace, 'warn' | 'debug'> | null;
  /** Where the attempt rows go: a summary's onto its run's history. A
   *  helper call belongs to no history and records nothing. */
  readonly record: {
    /** Record the attempt before it is billed; the address of the request
     *  it recorded. */
    readonly attempt: (
      ref: InvocationRef,
      bound: BoundModel,
      resolved: ResolvedTurn,
    ) => Effect.Effect<string, Error>;
    readonly failed: (
      ref: InvocationRef,
      error: RetryErrorInfo,
      next: FailedNext,
    ) => Effect.Effect<void, Error>;
  } | null;
}

/**
 * One completed call outside a turn, through {@link runInvocation}: prepared
 * in the foreground, streamed to its completed result, priced and reported.
 * Its invocation is folded here from the same rows `record` writes, since no
 * loop continues from them: a summary cut short by a crash is made anew.
 */
export const callModel = Effect.fn('ModelInvoker.call')(function* <R>(
  call: ModelCall<R>,
): Effect.fn.Return<CallResult, Error, UsageLog | R | HttpClient.HttpClient> {
  const usageLog = yield* UsageLog;
  // The trace's sinks are synchronous; with no trace, lines queue here and
  // leave through the Effect logger at the next step.
  const queued: Effect.Effect<void>[] = [];
  const logger = call.logger ?? {
    warn: (message: string) => void queued.push(Effect.logWarning(message)),
    debug: (message: string) => void queued.push(Effect.logDebug(message)),
  };
  const flush = Effect.suspend(() =>
    Effect.all(queued.splice(0), { discard: true }),
  );
  const held = yield* Ref.make<Invocation | null>(null);
  const fold = (
    payload: Parameters<typeof invocationAfter>[1],
  ): Effect.Effect<void> =>
    Ref.get(held).pipe(
      Effect.flatMap((invocation) => {
        const next = invocationAfter(invocation, payload);
        return typeof next === 'string'
          ? Effect.die(new Error(`A ${call.purpose} call's attempt: ${next}`))
          : Ref.set(held, next);
      }),
    );
  const ended = yield* runInvocation<CallResult, Error, R | UsageLog>({
    read: Effect.map(Ref.get(held), (invocation) => ({
      invocation,
      requests: {},
    })),
    binding: call.binding,
    rebind: (_credentials, failed) =>
      Effect.as(call.reacquire(failed), Result.succeed(undefined)),
    attempt: (bound, ref) =>
      Effect.gen(function* () {
        const prepared = yield* bound.model.prepareTurn(call.request).pipe(
          Effect.mapError(
            (cause) =>
              new AttemptFailed({
                failure: classifyModelFailure(cause, bound),
              }),
          ),
        );
        if (prepared.mode !== 'foreground') {
          return yield* Effect.die(
            new Error(`A ${call.purpose} call prepared as background work.`),
          );
        }
        yield* fold({
          kind: 'attempt',
          invocation: ref,
          purpose: 'summary',
          // A helper's request is recorded nowhere: its address is the
          // prepared turn's own.
          request:
            call.record === null
              ? sha256(prepared)
              : yield* call.record.attempt(ref, bound, prepared),
          origin: bound.origin,
        });
        const started = yield* Clock.currentTimeMillis;
        const turn = yield* completedTurn(
          bound.model.streamTurn(prepared),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new AttemptFailed({
                failure: classifyModelFailure(cause, bound),
              }),
          ),
        );
        const usage = priceTurnUsage(
          bound,
          turn.usage,
          (yield* Clock.currentTimeMillis) - started,
        );
        yield* reportUsage(
          usageLog,
          bound,
          usage,
          call.attribution,
          call.settings,
        );
        return { turn, usage };
      }),
    failed: (ref, failure, next) =>
      Effect.gen(function* () {
        if (call.record !== null)
          yield* call.record.failed(ref, failure.info, next);
        yield* fold({
          kind: 'failed',
          invocation: ref,
          purpose: 'summary',
          error: failure.info,
          next,
        });
      }),
    asker: null,
    // The request carries no continuation.
    chains: () => Effect.succeed(false),
    retries: call.retries ?? (yield* call.binding).automaticRetries,
    gate: call.gate,
    secrets: call.secrets,
    logger,
  }).pipe(Effect.ensuring(flush));
  if ('turn' in ended) return ended;
  return yield* Effect.fail(
    ended.kind === 'failed'
      ? (ended.cause ?? new Error(ended.error.message))
      : new Error(`The ${call.purpose} call was cancelled.`),
  );
});
