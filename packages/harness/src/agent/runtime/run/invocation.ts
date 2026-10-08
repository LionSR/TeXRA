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
import { ModelError } from '@texra-ai/llm';

import type { AgentTrace } from '@agent/trace';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import {
  offersRetry,
  routePolicies,
  type CallFailure,
} from '@agent/runtime/modelAccess/failureInfo';
import { RouteUnavailable } from '@common/errors/agentErrors';
import {
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

import type { ModelRetryGate } from '../ModelRetryGate';

/** The process's one retry gate, served by `processLayer`: a 429 cools a
 *  credential for every run of every project. */
export class RouteRetries extends Context.Service<
  RouteRetries,
  ModelRetryGate
>()('@texra/RouteRetries') {}

/** Base delay between automatic attempts; the gate scales its own on top. */
const RETRY_BACKOFF_MS = 1000;

/** A failed attempt: llm's verdict, or no route to send it on. */
const isCallFailure = (error: unknown): error is CallFailure =>
  error instanceof ModelError || error instanceof RouteUnavailable;

/**
 * One failure of attempt `ref`, as its driver records it. `unsent` marks a
 * binding that could not be replaced (a renewal or a rebind that failed):
 * nothing was sent, and no retry repeats it.
 */
export interface AttemptFailure {
  readonly error: CallFailure;
  readonly unsent: boolean;
}

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
   *  it picked), a renewed subscription token, or a connection a failure
   *  killed. */
  readonly rebind: (
    credentials: RetryCredentials | 'renewed',
    failed: BoundModel,
  ) => Effect.Effect<Result.Result<unknown, CallFailure>, never, R>;
  /** One billed attempt `ref` on `bound`, its attempt row first, or the
   *  observation of the operation it left accepted (unbilled). */
  readonly attempt: (
    bound: BoundModel,
    ref: InvocationRef,
    accepted: Attempt['accepted'],
  ) => Effect.Effect<A, CallFailure | E, R>;
  /** Record the failure of attempt `ref` and the move after it; the
   *  failure as recorded. */
  readonly failed: (
    ref: InvocationRef,
    failure: AttemptFailure,
    next: FailedNext,
    bound: BoundModel,
  ) => Effect.Effect<RetryErrorInfo, E, R>;
  /** A turn's person; null where nobody can be asked. */
  readonly asker: Asker<E, R> | null;
  /** Whether an attempt on `bound` sends a continuation, which a vendor
   *  that lost it answers with `continuation-gone`. */
  readonly chains: (bound: BoundModel) => Effect.Effect<boolean>;
  /** Automatic resends per invocation. */
  readonly retries: number;
  readonly logger: Pick<AgentTrace, 'warn' | 'debug'>;
}

/** How an invocation ends when it delivers nothing. */
export type InvocationEnd =
  | {
      readonly kind: 'failed';
      readonly error: RetryErrorInfo;
      /** The live failure, when this process saw it. */
      readonly cause: CallFailure | null;
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
 * server-side): the binding rebound on a refreshed session. `true` when the
 * attempt may go again on it. A renewal that fails takes the stale 401's
 * place as an unsent failure, so the user reads the "sign in again"
 * instruction rather than "token is expired", and no retry resends the
 * rejected token.
 */
const credentialRenewal = <R>(
  rebind: InvocationDriver<unknown, unknown, R>['rebind'],
) => {
  let spent = false;
  return (
    failure: AttemptFailure,
    bound: BoundModel,
  ): Effect.Effect<AttemptFailure | true, never, R> => {
    const route = bound.usageRoute;
    if (
      spent ||
      !(failure.error instanceof ModelError) ||
      failure.error.status !== StatusCodes.UNAUTHORIZED ||
      (route !== 'chatgpt-subscription' && route !== 'xai-subscription')
    )
      return Effect.succeed(failure);
    spent = true;
    return Effect.map(rebind('renewed', bound), (result) =>
      Result.isSuccess(result)
        ? (true as const)
        : { error: result.failure, unsent: true },
    );
  };
};

/** Rebind before sending `ref` on a person's retry answer, or when the
 *  binding in force is the Responses WebSocket the last attempt `failedOn`
 *  (it died with it, #13407). A failed rebind is `ref`'s failure, recorded
 *  unsent, so nothing goes out on the binding it meant to leave: false. */
const rebound = Effect.fn('ModelInvoker.rebound')(function* <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  move: Extract<Move, { kind: 'send' | 'observe' }>,
  failedOn: BoundModel | null,
  ref: InvocationRef,
): Effect.fn.Return<boolean, E, R> {
  const bound = yield* driver.binding;
  if (move.kind !== 'send') return true;
  const dead = failedOn === bound && bound.persistentConnection;
  if (move.retry === null && !dead) return true;
  const result = yield* driver.rebind(move.retry ?? 'configured', bound);
  if (Result.isSuccess(result)) return true;
  const failure = { error: result.failure, unsent: true };
  const next = yield* moveAfter(driver, failure, ref, bound, false);
  yield* driver.failed(ref, failure, next, bound);
  return false;
});

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
): Effect.Effect<{ readonly ok: A } | AttemptFailure, E, R | RouteRetries> =>
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
      (exit): Effect.Effect<{ readonly ok: A } | AttemptFailure, E> => {
        if (Exit.isSuccess(exit)) return Effect.succeed({ ok: exit.value });
        if (Cause.hasInterrupts(exit.cause)) return Effect.interrupt;
        const found = Cause.findError(exit.cause);
        if (Result.isFailure(found))
          return Effect.die(Cause.squash(exit.cause));
        const error = found.success;
        return isCallFailure(error)
          ? Effect.succeed({ error, unsent: false })
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

/** The pause before an automatic resend, unchained or not. */
const pauseBefore = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  next: FailedNext,
  failure: AttemptFailure,
): Effect.Effect<void> => {
  if (next.kind === 'unchain')
    driver.logger.warn(
      `Chained response gone (${failure.error.message}); retrying once with the full transcript.`,
    );
  else if (next.kind === 'retry')
    driver.logger.debug(
      `Model request failed; automatic retry in ${RETRY_BACKOFF_MS}ms.`,
      { data: failure.error.message },
    );
  else return Effect.void;
  return Effect.sleep(RETRY_BACKOFF_MS);
};

/** The move after `failure` of attempt `ref`, read off the attempts
 *  before it, llm's verdict and the budget. */
const moveAfter = <A, E, R>(
  driver: InvocationDriver<A, E, R>,
  { error, unsent }: AttemptFailure,
  ref: InvocationRef,
  bound: BoundModel,
  observed: boolean,
): Effect.Effect<FailedNext> =>
  Effect.zipWith(driver.read, driver.chains(bound), ({ invocation }, chains) =>
    failedNext(
      failuresBefore(invocation, ref),
      {
        // A 404 on a request that chained nothing is an ordinary failure,
        // and a failed observation is never resubmitted unasked: the work
        // it watched was already billed.
        unchain:
          !observed &&
          chains &&
          error instanceof ModelError &&
          error.kind === 'continuation-gone',
        automatic:
          !observed &&
          !unsent &&
          error instanceof ModelError &&
          error.retryable,
        offered: !unsent && offersRetry(error),
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
  failed: AttemptFailure,
  move: Extract<Move, { kind: 'send' | 'observe' }>,
  ref: InvocationRef,
  bound: BoundModel,
): Effect.Effect<
  { readonly failure: AttemptFailure; readonly next: FailedNext } | null,
  never,
  R
> =>
  renew(failed, bound).pipe(
    Effect.flatMap((renewed) => {
      if (renewed !== true)
        return Effect.map(
          moveAfter(driver, renewed, ref, bound, move.kind === 'observe'),
          (next) => ({ failure: renewed, next }),
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
): Effect.fn.Return<A | InvocationEnd, E, R | RouteRetries> {
  const renew = credentialRenewal(driver.rebind);
  // A renewed credential observes the same operation again, unrecorded;
  // `failedOn` is the binding the last attempt went out on.
  let again: Move | null = null;
  let failedOn: BoundModel | null = null;
  for (;;) {
    const { invocation, requests } = yield* driver.read;
    const move: Move = again ?? nextAttempt(invocation, requests);
    again = null;
    if (move.kind === 'fail' || move.kind === 'cancel') return ended(move);
    if (move.kind === 'await' || move.kind === 'reask') {
      if (!(yield* consult(driver, move))) return CANCELLED;
      continue;
    }
    const ref =
      move.kind === 'observe' ? move.attempt.ref : nextRef(invocation);
    if (!(yield* rebound(driver, move, failedOn, ref))) continue;
    const bound = yield* driver.binding;
    failedOn = bound;
    const tried = yield* tryAttempt(driver, move, ref, bound);
    if ('ok' in tried) return tried.ok;
    const after = yield* afterFailure(driver, renew, tried, move, ref, bound);
    if (after === null) {
      again = move;
      continue;
    }
    const { failure, next } = after;
    const recorded = yield* driver.failed(ref, failure, next, bound);
    if (next.kind === 'stop')
      return { kind: 'failed', error: recorded, cause: failure.error };
    if (next.kind === 'cancel') return CANCELLED;
    yield* pauseBefore(driver, next, failure);
  }
});
