/**
 * A host attached to one session of `@texra-ai/harness`: its presentation
 * surface, and its approval handler at work, which requests it is asked
 * (once each) and what is recorded when it does not answer. A request is
 * never left waiting on a handler that failed, threw, or went quiet: that is
 * a denial, with the cause logged.
 */
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberMap,
  Schedule,
  type Scope,
  Stream,
} from 'effect';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { requestParksItsCaller, type RequestDecision } from '@shared/schemas';
import type {
  PendingRequest,
  SessionView,
} from '@shared/session/readonlyViews';
import { attentionOf } from '@shared/session/sessionView';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ApprovalHandler, SessionHost } from './sessions.js';

const CHANNEL = 'agentPackage';

/** How long the handler has to answer one request before it is denied. */
const APPROVAL_HANDLER_TIMEOUT = Duration.minutes(10);

/** How a decision the session refused to record is tried again, briefly,
 *  before the next view offers its request again. */
const DECIDE_RETRY = Schedule.exponential('100 millis').pipe(Schedule.jittered);

/** The handler's decision on `pending`, or a denial naming why it gave
 *  none: a failure, a throw, or no answer in time. A withdrawal (the
 *  prompt interrupted) stays one: it is no decision at all. */
const decisionOf = (
  host: AnsweringHost,
  pending: PendingRequest,
): Effect.Effect<RequestDecision> =>
  // Called on the host itself: a class-based host keeps its receiver.
  Effect.suspend(() => host.approve(pending)).pipe(
    Effect.timeout(APPROVAL_HANDLER_TIMEOUT),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(
            `The approval handler gave no decision on request ${pending.requestId}; it is denied`,
          ).pipe(
            Effect.annotateLogs({ data: cause }),
            withLogChannel(CHANNEL),
            Effect.as<RequestDecision>({
              action: 'deny',
              reason: `The approval handler gave no decision: ${toErrorMessage(Cause.squash(cause))}`,
            }),
          ),
    ),
  );

/**
 * Run `program` once for each request `select` picks from the session's
 * view, for as long as the view lists it. A program that returns runs again
 * on the next view that still lists its request; one that holds something
 * for its request (a decision on record, a preview, a staged card) ends with
 * `Effect.never` and releases it in a finalizer, which runs once the view
 * drops the request, however it was decided.
 */
export const followPendingRequests = <P extends PendingRequest, R>(
  view: { readonly changes: Stream.Stream<SessionView> },
  select: (view: SessionView) => readonly P[],
  program: (request: P) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    // Keyed by run and request, as the fold keys a pending request.
    const keyOf = (request: PendingRequest): string =>
      `${request.runId}\0${request.requestId}`;
    const fibers = yield* FiberMap.make<string>();
    yield* Stream.runForEach(view.changes, (level) => {
      const listed = new Set(level.requests.map(keyOf));
      return Effect.forEach(
        [...fibers].filter(([key]) => !listed.has(key)),
        // Forked: the view loop never waits on a program's finalizers.
        ([, fiber]) => Effect.forkChild(Fiber.interrupt(fiber)),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.forEach(
            select(level),
            (request) =>
              FiberMap.run(fibers, keyOf(request), program(request), {
                onlyIfMissing: true,
              }),
            { discard: true },
          ),
        ),
      );
    });
  });

/**
 * Answer the runs' requests of `session` with the host's `approve`, until
 * interrupted: every request a waiting run waits on here (the attention rule
 * every host reads), once, through the session's one `request.decide`. A
 * decision the session refuses to record is tried again briefly, then
 * logged and its request offered again on the next view; a handler still
 * deciding a request that left the view (another surface answered it) is
 * interrupted.
 */
const answerRequests = (
  session: RuntimeSessionHandle,
  host: AnsweringHost,
): Effect.Effect<void, never, Scope.Scope> =>
  followPendingRequests(
    session.view,
    (view) =>
      attentionOf(view).requests.filter((pending) =>
        requestParksItsCaller(pending.payload),
      ),
    (pending) =>
      decisionOf(host, pending).pipe(
        Effect.flatMap((decision) =>
          session.requests
            .request({
              kind: 'request.decide',
              runId: pending.runId,
              requestId: pending.requestId,
              decision,
            })
            .pipe(Effect.retry({ schedule: DECIDE_RETRY, times: 3 })),
        ),
        // A decided request stays held until the view drops it, so the fold
        // catching up cannot re-ask it.
        Effect.andThen(Effect.never),
        // An interrupt is a withdrawal; anything else is logged.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(
                `The decision on request ${pending.requestId} was not recorded; it is offered again on the next view`,
              ).pipe(
                Effect.annotateLogs({ data: cause }),
                withLogChannel(CHANNEL),
              ),
        ),
      ),
  );

/**
 * Attach `host` to `session` for the caller's scope, the session's one host:
 * it presents, and its handler answers the runs' requests, until the scope
 * or the session closes. A host with a handler can answer whatever its
 * surface says.
 */
export function attachHost(
  session: RuntimeSessionHandle,
  host: SessionHost,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    // The session disposes its host as it closes: the answerer ends then.
    const ended = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      session.interactions.use(
        overlay(host, () => Deferred.doneUnsafe(ended, Effect.void)),
      ),
      (detach) => Effect.sync(detach),
    );
    if (!answers(host)) return;
    // The session ended: closing the answerer's scope interrupts every
    // prompt still out, so none decides against it.
    yield* Effect.forkScoped(
      Effect.scoped(answerRequests(session, host)).pipe(
        Effect.raceFirst(Deferred.await(ended)),
      ),
    );
  });
}

/** A host that answers the runs' requests. */
type AnsweringHost = SessionHost & { readonly approve: ApprovalHandler };

const answers = (host: SessionHost): host is AnsweringHost =>
  host.approve !== undefined;

/**
 * `host` as the session's attachment sees it: the host object itself, its
 * members read off it with their receiver (a class-based host keeps its
 * prototype's methods and private state), with the session's `dispose`
 * and, for a host that answers, `approvalPromptsUnavailable: false` laid
 * over it.
 */
function overlay(host: SessionHost, dispose: () => void): HostInteractions {
  // A `SessionHost` is a `HostInteractions` (every member optional) with an
  // `approve` the session never reads through this view.
  const view: HostInteractions = host;
  return new Proxy(view, {
    get(target, key) {
      if (key === 'dispose') return dispose;
      if (key === 'approvalPromptsUnavailable' && answers(host)) return false;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
