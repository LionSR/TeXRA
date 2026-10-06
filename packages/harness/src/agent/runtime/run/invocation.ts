/**
 * The one retry loop every model call runs.
 *
 * An invocation is a series of billed attempts. Its rows say where it
 * stands, and `nextAttempt` reads the next move off them, so the loop keeps
 * no count and no permit of its own: a resume continues the same series
 * under the same budget. A turn (`ModelInvoker.invoke`) keeps its
 * invocation in the run's fold and may ask a person; a compaction summary
 * and a helper call keep theirs in memory (`modelCall.ts`).
 */
import { randomUUID } from 'node:crypto';

import { StatusCodes } from 'http-status-codes';
import { Cause, Context, Effect, Exit, Result } from 'effect';

import type { AgentTrace } from '@agent/trace';
import {
  attachProviderError,
  hasMissingApiKeyErrorMarker,
} from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import type { PlatformSecrets } from '@platform/secrets';
import {
  toRetryErrorInfo,
  type FailedNext,
  type InvocationRef,
  type RetryErrorInfo,
} from '@shared/schemas';
import {
  failedNext,
  failuresBefore,
  nextAttempt,
  type Attempt,
  type Invocation,
  type Move,
  type RetryCredentials,
} from '@shared/session/inFlight';
import type { RunPosition } from '@shared/session/runRows';

import { refreshRejectedSubscription } from '../modelRoutes';
import {
  AttemptFailed,
  classifyModelFailure,
  routePolicies,
  type ModelFailure,
} from './modelFailure';
import type { HttpClient } from 'effect/http';
import type { ModelRetryGate } from '../ModelRetryGate';
import type { BoundModel } from './modelBinding';

/** The process's one retry gate, served by `processLayer`: a 429 cools a
 *  credential for every run of every project. */
export class RouteRetries extends Context.Service<
  RouteRetries,
  ModelRetryGate
>()('@texra/RouteRetries') {}

/** Base delay between automatic attempts; the gate scales its own on top. */
const RETRY_BACKOFF_MS = 1000;

const isAttemptFailed = (error: unknown): error is AttemptFailed =>
  error instanceof AttemptFailed;

/** Where an invocation stands: its attempts, and the run's requests a
 *  person answers (none off a run). */
interface InvocationView {
  readonly invocation: Invocation | null;
  readonly requests: RunPosition['requests'];
}

/** The answer to a question only a turn can ask: a turn's driver alone
 *  records an `ask` or an accepted operation. */
interface Asker<E, R> {
  /** Wait for the answer to the open retry request; false when nobody
   *  will answer it (the session closed). */
  readonly await: (requestId: string) => Effect.Effect<boolean, E, R>;
  /** Ask again about `attempt`, which a person admitted and whose outcome
   *  no row records. */
  readonly reask: (attempt: Attempt) => Effect.Effect<void, E, R>;
  /** Mint the id of a retry request the next failure may open. */
  readonly requestId: () => string;
}

/** What one invocation's caller supplies to {@link runInvocation}. */
export interface InvocationDriver<A, E, R> {
  /** The invocation as its rows stand, read before every move. */
  readonly read: Effect.Effect<InvocationView>;
  /** The binding in force, read again before every attempt. */
  readonly binding: Effect.Effect<BoundModel>;
  /** Replace `failed`: after a person's retry answer (on the credentials
   *  it picked), a refreshed credential, or a connection a failure killed. */
  readonly rebind: (
    credentials: RetryCredentials,
    failed: BoundModel,
  ) => Effect.Effect<Result.Result<unknown, Error>, never, R>;
  /** One billed attempt `ref` on `bound`, its attempt row first, or the
   *  observation of the operation it left accepted (unbilled). */
  readonly attempt: (
    bound: BoundModel,
    ref: InvocationRef,
    accepted: Attempt['accepted'],
  ) => Effect.Effect<A, AttemptFailed | E, R>;
  /** Record the failure of attempt `ref` and the move after it. */
  readonly failed: (
    ref: InvocationRef,
    failure: ModelFailure,
    next: FailedNext,
    bound: BoundModel,
  ) => Effect.Effect<void, E, R>;
  /** A turn's person; null where nobody can be asked. */
  readonly asker: Asker<E, R> | null;
  /** Whether an attempt on `bound` sends a continuation, which a vendor
   *  that lost it answers with `continuation-gone`. */
  readonly chains: (bound: BoundModel) => Effect.Effect<boolean>;
  /** Automatic resends per invocation. */
  readonly retries: number;
  readonly secrets: PlatformSecrets;
  readonly logger: Pick<AgentTrace, 'warn' | 'debug'>;
}

/** How an invocation ends when it delivers nothing. */
export type InvocationEnd =
  | {
      readonly kind: 'failed';
      readonly error: RetryErrorInfo;
      /** The live failure, when this process saw it. */
      readonly cause: Error | null;
    }
  | { readonly kind: 'cancelled' };

/** The next attempt's reference: the invocation's next, or a new one. */
const nextRef = (invocation: Invocation | null): InvocationRef =>
  invocation === null
    ? { invocationId: randomUUID(), attempt: 1 }
    : {
        invocationId: invocation.current.ref.invocationId,
        attempt: invocation.current.ref.attempt + 1,
      };

/**
 * The once-per-invocation renewal of a subscription access token the
 * provider rejects before its stored expiry (revoked, or expired
 * server-side): refreshed, and the binding rebound on the new session.
 * `true` when the attempt may go again on it. A refresh or rebind that fails
 * takes the stale 401's place as a terminal failure, so the user reads the
 * "sign in again" instruction rather than "token is expired", and no retry
 * resends the rejected token.
 */
const credentialRenewal = <R>(
  secrets: PlatformSecrets,
  rebind: InvocationDriver<unknown, unknown, R>['rebind'],
) => {
  let spent = false;
  return (
    failure: ModelFailure,
    bound: BoundModel,
  ): Effect.Effect<ModelFailure | true, never, R | HttpClient.HttpClient> => {
    const route = bound.usageRoute;
    if (
      spent ||
      failure.formatted.statusCode !== StatusCodes.UNAUTHORIZED ||
      (route !== 'chatgpt-subscription' && route !== 'xai-subscription')
    )
      return Effect.succeed(failure);
    spent = true;
    return refreshRejectedSubscription(route, secrets).pipe(
      Effect.andThen(rebind('configured', bound)),
      Effect.flatMap(Effect.fromResult),
      Effect.as(true as const),
      Effect.catch((error: Error) => {
        const failed = classifyModelFailure(error, bound);
        const formatted = { ...failed.formatted, userRetryable: false };
        attachProviderError(failed.error, formatted);
        return Effect.succeed({
          ...failed,
          formatted,
          info: toRetryErrorInfo(formatted),
          autoRetryable: false,
        });
      }),
    );
  };
};

/**
 * Make the attempt `move` names on `bound`: a send under the process's route
 * gate, so every run on one credential shares cooling, or an observation,
 * unbilled, outside it. An interruption stays the run's and a driver's own
 * failure (a refused write) its own; anything else is a defect.
 */
const tryAttempt = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  move: Extract<Move, { kind: 'send' | 'observe' }>,
  ref: InvocationRef,
  bound: BoundModel,
): Effect.Effect<{ readonly ok: A } | AttemptFailed, E, R | RouteRetries> =>
  Effect.exit(
    move.kind === 'send'
      ? Effect.flatMap(RouteRetries, (gate) =>
          gate.withRoutes(routePolicies(bound), {
            baseBackoffMs: RETRY_BACKOFF_MS,
            onWait: (delayMs) =>
              driver.logger.debug(
                `Waiting ${delayMs}ms for the model recovery probe.`,
              ),
          })(driver.attempt(bound, ref, null)),
        )
      : driver.attempt(bound, ref, move.attempt.accepted),
  ).pipe(
    Effect.flatMap(
      (exit): Effect.Effect<{ readonly ok: A } | AttemptFailed, E> => {
        if (Exit.isSuccess(exit)) return Effect.succeed({ ok: exit.value });
        if (Cause.hasInterrupts(exit.cause)) return Effect.interrupt;
        const found = Cause.findError(exit.cause);
        if (Result.isFailure(found))
          return Effect.die(Cause.squash(exit.cause));
        const error = found.success;
        return isAttemptFailed(error)
          ? Effect.succeed(error)
          : Effect.fail(error);
      },
    ),
  );

/** Wait on the person a turn asks: the answer to its open retry request,
 *  or the question again; false when nobody will answer (the session
 *  closed). Only a turn's own rows ask; a driver without a person never
 *  does. */
const consult = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  move: Extract<Move, { kind: 'await' | 'reask' }>,
): Effect.Effect<boolean, E, R> => {
  const { asker } = driver;
  if (asker === null)
    return Effect.die(
      new Error('An invocation nobody can be asked about asked.'),
    );
  return move.kind === 'reask'
    ? Effect.as(asker.reask(move.attempt), true)
    : asker.await(move.requestId);
};

/** The pause before an automatic resend, unchained or not: the backoff,
 *  then a fresh connection where the failed one died with the attempt. */
const pauseBefore = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  next: FailedNext,
  failure: ModelFailure,
  bound: BoundModel,
): Effect.Effect<void, never, R> => {
  if (next.kind === 'unchain')
    driver.logger.warn(
      `Chained response gone (${failure.info.message}); retrying once with the full transcript.`,
    );
  else if (next.kind === 'retry')
    driver.logger.debug(
      `Model request failed; automatic retry in ${RETRY_BACKOFF_MS}ms.`,
      { data: failure.info.message },
    );
  else return Effect.void;
  return Effect.sleep(RETRY_BACKOFF_MS).pipe(
    // A Responses WebSocket dies with a failed turn and ages out after 55
    // minutes, so retrying on it cannot succeed (#13407).
    Effect.andThen(
      bound.persistentConnection
        ? Effect.asVoid(driver.rebind('configured', bound))
        : Effect.void,
    ),
  );
};

/** The move after `failure` of attempt `ref`, read off the attempts
 *  before it, the failure's facts and the budget. */
const moveAfter = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  failure: ModelFailure,
  ref: InvocationRef,
  bound: BoundModel,
  observed: boolean,
): Effect.Effect<FailedNext> =>
  Effect.zipWith(driver.read, driver.chains(bound), ({ invocation }, chains) =>
    failedNext(
      failuresBefore(invocation, ref),
      {
        abort: isUserAbort(failure.error),
        // A 404 on a request that chained nothing is an ordinary failure,
        // and a failed observation is never resubmitted unasked: the work
        // it watched was already billed.
        unchain: !observed && chains && failure.storedResponseGone,
        automatic: !observed && failure.autoRetryable,
        offered:
          failure.formatted.userRetryable &&
          !hasMissingApiKeyErrorMarker(failure.error),
      },
      driver.retries,
      driver.asker?.requestId() ?? null,
    ),
  );

const CANCELLED: InvocationEnd = { kind: 'cancelled' };

/** How a recorded end of an invocation ends it again. */
const ended = (
  move: Extract<Move, { kind: 'fail' | 'cancel' }>,
): InvocationEnd =>
  move.kind === 'fail'
    ? { kind: 'failed', error: move.error, cause: null }
    : CANCELLED;

/**
 * What follows failed attempt `ref`: null to observe the same operation
 * again on a renewed credential, else the failure its `failed` row records
 * and the move after it (a renewed credential resends at once).
 */
const afterFailure = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  renew: ReturnType<typeof credentialRenewal<R>>,
  failed: ModelFailure,
  move: Extract<Move, { kind: 'send' | 'observe' }>,
  ref: InvocationRef,
  bound: BoundModel,
): Effect.Effect<
  { readonly failure: ModelFailure; readonly next: FailedNext } | null,
  never,
  R | HttpClient.HttpClient
> =>
  renew(failed, bound).pipe(
    Effect.flatMap((renewed) => {
      if (renewed !== true)
        return Effect.map(
          moveAfter(driver, renewed, ref, bound, move.kind === 'observe'),
          (next) => ({
            failure: renewed,
            next,
          }),
        );
      return Effect.succeed(
        move.kind === 'observe'
          ? null
          : { failure: failed, next: { kind: 'retry' } as const },
      );
    }),
  );

/**
 * Drive one invocation to its result or its end: read the next move off its
 * rows, make it, and, when an attempt fails, record why and what follows.
 */
export const runInvocation = Effect.fn('ModelInvoker.invocation')(function* <
  A,
  E,
  R,
>(
  driver: InvocationDriver<A, E, R>,
): Effect.fn.Return<
  A | InvocationEnd,
  E,
  R | HttpClient.HttpClient | RouteRetries
> {
  const renew = credentialRenewal(driver.secrets, driver.rebind);
  // A renewed credential observes the same operation again, unrecorded.
  let again: Move | null = null;
  for (;;) {
    const { invocation, requests } = yield* driver.read;
    const move: Move = again ?? nextAttempt(invocation, requests);
    again = null;
    if (move.kind === 'fail' || move.kind === 'cancel') return ended(move);
    if (move.kind === 'await' || move.kind === 'reask') {
      if (!(yield* consult(driver, move))) return CANCELLED;
      continue;
    }
    // A key or preference may have changed while the person decided.
    if (move.kind === 'send' && move.retry !== null)
      yield* driver.rebind(move.retry, yield* driver.binding);
    const bound = yield* driver.binding;
    const ref =
      move.kind === 'observe' ? move.attempt.ref : nextRef(invocation);
    const tried = yield* tryAttempt(driver, move, ref, bound);
    if ('ok' in tried) return tried.ok;
    const after = yield* afterFailure(
      driver,
      renew,
      tried.failure,
      move,
      ref,
      bound,
    );
    if (after === null) {
      again = move;
      continue;
    }
    const { failure, next } = after;
    yield* driver.failed(ref, failure, next, bound);
    if (next.kind === 'stop')
      return { kind: 'failed', error: failure.info, cause: failure.error };
    if (next.kind === 'cancel') return CANCELLED;
    yield* pauseBefore(driver, next, failure, bound);
  }
});
