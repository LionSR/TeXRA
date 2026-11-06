/**
 * One completed model call off a run's rows: a compaction summary on its
 * run's binding, or a helper call (a session description, a draft polish)
 * on a binding of its own. No row records it, so no resume continues it: a
 * call cut short is made anew. Like a turn it is sent under the process's
 * route gate, priced and reported to the usage log; unlike a turn it asks
 * nobody, so it is resent only while llm says the same request can succeed,
 * up to the binding's automatic retries, and a subscription token the
 * provider rejects before its stored expiry is renewed once.
 */
import { Clock, Effect } from 'effect';
import {
  completedTurn,
  ModelError,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm';

import type { CallFailure } from '@agent/runtime/modelAccess/failureInfo';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { RouteRetries } from '@agent/runtime/ModelRetryGate';
import type { SettingsStores } from '@shared/config/settings';
import type { NormalizedUsage } from '@shared/schemas';
import { UsageLog } from '@shared/usageLog';

import { priceTurnUsage, reportUsage, type UsageAttribution } from './pricing';

/** Base delay between automatic resends; the route gate scales its own on
 *  top for a failure llm scoped to a route. */
export const RETRY_BACKOFF_MS = 1000;

/** A completed call and its priced usage (`null`: none reported). */
export interface CallResult {
  readonly turn: TurnResult;
  readonly usage: NormalizedUsage | null;
}

interface ModelCall<R> {
  /** The binding in force, read again before every attempt. */
  readonly binding: Effect.Effect<BoundModel>;
  /** Rebind on a refreshed subscription session after the provider
   *  rejected `failed`'s token; a failure here ends the call with it, so
   *  the person reads "sign in again" and nothing resends the token. */
  readonly renew: (
    failed: BoundModel,
  ) => Effect.Effect<unknown, CallFailure, R>;
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

/** The pause before an automatic resend: as long as the provider asked,
 *  else the base backoff; none for a failure llm scoped to a route, which
 *  the gate cools and waits out before the next send. */
const pauseOf = (error: ModelError): number =>
  error.scope !== undefined ? 0 : (error.retryAfterMs ?? RETRY_BACKOFF_MS);

/**
 * One completed call off a run's rows: prepared in the foreground, streamed
 * to its completed result under the route gate, priced and reported.
 */
export const callModel = Effect.fn('ModelInvoker.call')(function* <R>(
  call: ModelCall<R>,
): Effect.fn.Return<
  CallResult,
  CallFailure | Error,
  UsageLog | RouteRetries | R
> {
  const usageLog = yield* UsageLog;
  const gate = yield* RouteRetries;
  const retries = call.retries ?? (yield* call.binding).automaticRetries;
  let resent = 0;
  let renewed = false;
  const attempt = Effect.fn('modelCall.attempt')(function* (bound: BoundModel) {
    const prepared = yield* bound.model.prepareTurn(call.request);
    if (prepared.mode !== 'foreground')
      return yield* Effect.die(
        new Error('A call off a run prepared as background work.'),
      );
    const started = yield* Clock.currentTimeMillis;
    const turn = yield* completedTurn(bound.model.streamTurn(prepared));
    const usage = priceTurnUsage(
      bound,
      turn.usage,
      (yield* Clock.currentTimeMillis) - started,
    );
    yield* reportUsage(usageLog, bound, usage, call.attribution, call.settings);
    return { turn, usage };
  });
  return yield* Effect.flatMap(call.binding, (bound) =>
    gate.withRoutes(bound.routes, { baseBackoffMs: RETRY_BACKOFF_MS })(
      attempt(bound),
    ),
  ).pipe(
    Effect.retry({
      while: (error: CallFailure | Error) =>
        Effect.gen(function* () {
          if (!(error instanceof ModelError)) return false;
          const bound = yield* call.binding;
          if (
            !renewed &&
            error.kind === 'authentication' &&
            bound.subscriptionToken !== undefined
          ) {
            renewed = true;
            yield* call.renew(bound);
            return true;
          }
          if (!error.retryable || resent >= retries) return false;
          resent += 1;
          const delayMs = pauseOf(error);
          yield* call.debug(
            `Model request failed; automatic retry in ${delayMs}ms.`,
          );
          if (delayMs > 0) yield* Effect.sleep(delayMs);
          return true;
        }),
    }),
  );
});
