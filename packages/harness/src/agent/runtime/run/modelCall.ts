/**
 * One completed model call off a run's rows: a compaction summary on its
 * run's binding, or a helper call (a session description, a draft polish)
 * on a binding of its own. No row records it, so no resume continues it: a
 * call cut short is made anew. Like a turn it is sent under the process's
 * route gate, priced and reported to the usage log; unlike a turn it asks
 * nobody, so it is resent only while llm says the same request can succeed,
 * up to the binding's automatic retries. A subscription token the provider
 * rejects is llm's to renew, inside the request.
 */
import { Duration, Effect, Schedule } from 'effect';
import {
  completedTurn,
  ModelError,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm';

import {
  routeFailureOf,
  type CallFailure,
} from '@agent/runtime/modelAccess/failureInfo';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { resendDelayMs, RouteRetries } from '@agent/runtime/ModelRetryGate';
import type { SettingsStores } from '@shared/config/settings';
import type { NormalizedUsage } from '@shared/schemas';
import { UsageLog } from '@shared/usageLog';

import { priceTurnUsage, reportUsage, type UsageAttribution } from './pricing';

/** A completed call and its priced usage (`null`: none reported). */
export interface ModelCallResult {
  readonly turn: TurnResult;
  readonly usage: NormalizedUsage | null;
}

interface ModelCall {
  /** The binding in force, read again before every attempt. */
  readonly binding: Effect.Effect<BoundModel>;
  /** A foreground request; each attempt prepares it on its binding. */
  readonly request: TurnRequest;
  /** The session's settings: usage consent reads them. */
  readonly settings: SettingsStores;
  readonly attribution: UsageAttribution;
  /** Automatic retries; the binding's when absent. */
  readonly retries?: number;
  /** Where a wait before a resend is said: a run's trace, else the logger. */
  readonly debug: (message: string) => Effect.Effect<void>;
}

/**
 * One completed call off a run's rows: prepared in the foreground, streamed
 * to its completed result under the route gate, priced and reported.
 */
export const callModel = Effect.fn('ModelInvoker.call')(function* (
  call: ModelCall,
): Effect.fn.Return<
  ModelCallResult,
  CallFailure | Error,
  UsageLog | RouteRetries
> {
  const usageLog = yield* UsageLog;
  const gate = yield* RouteRetries;
  const retries = call.retries ?? (yield* call.binding).automaticRetries;
  const attempt = Effect.fn('modelCall.attempt')(function* (bound: BoundModel) {
    const prepared = yield* bound.model.prepareTurn(call.request);
    if (prepared.mode !== 'foreground')
      return yield* Effect.die(
        new Error('A call off a run prepared as background work.'),
      );
    // Timed on the monotonic clock, which a wall-clock step cannot reverse.
    const [elapsed, turn] = yield* Effect.timed(
      completedTurn(bound.model.streamTurn(prepared)),
    );
    const responseTimeMs = Duration.toMillis(elapsed);
    const usage = priceTurnUsage(bound, turn.usage, responseTimeMs);
    yield* reportUsage(
      usageLog,
      bound,
      turn.usage,
      responseTimeMs,
      call.attribution,
      call.settings,
    );
    return { turn, usage };
  });
  return yield* Effect.flatMap(call.binding, (bound) =>
    gate.withRoutes(bound.routes)(attempt(bound)),
  ).pipe(
    Effect.retry(
      Schedule.forever.pipe(
        Schedule.while(
          ({ input, attempt }) =>
            input instanceof ModelError &&
            input.retryable &&
            attempt <= retries,
        ),
        // Only a failure the check above resends reaches the wait, so the
        // line is never said for a call that ends.
        Schedule.modifyDelay(({ input }) => {
          const delayMs = resendDelayMs(input);
          return Effect.as(
            call.debug(
              `Model request failed; automatic retry in ${delayMs}ms.`,
            ),
            Duration.millis(delayMs),
          );
        }),
      ),
    ),
    Effect.mapError((error) =>
      error instanceof ModelError ? routeFailureOf(error) : error,
    ),
  );
});
