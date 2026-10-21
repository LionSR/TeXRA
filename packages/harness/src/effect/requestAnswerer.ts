/**
 * A host attached to one session of `@texra-ai/harness`: its presentation
 * surface, and its approval handler at work, which requests it is asked
 * (once each) and what is recorded when it does not answer. A request is
 * never left parked on a handler that failed, threw, or went quiet: that is
 * a denial, with the cause logged.
 */
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Queue,
  Schedule,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { requestParksItsCaller, type RequestDecision } from '@shared/schemas';
import type { PendingRequest } from '@shared/session/readonlyViews';
import type { RequestError } from '@shared/session/requestErrors';
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

/** One attached host with an approval handler, on its session's list
 *  (newest last): the wake that tells it it became the newest, its prompts
 *  in flight (withdrawn when a newer handler attaches), and how its surface
 *  hears that a decision it made went to a newer one. A host without a
 *  handler (a viewer) is not on the list: it never takes prompts over. */
export interface Approver {
  readonly host: AnsweringHost;
  readonly wake: Queue.Queue<void>;
  readonly prompts: FiberSet.FiberSet<void>;
  readonly superseded: (pending: PendingRequest) => Effect.Effect<void>;
}

/**
 * Answer the runs' requests of `session` with `approve` while it is the
 * newest attached handler (`active`), until interrupted: every request a
 * parked run waits on here (the attention rule every host reads), once,
 * through the session's one `request.decide`. It reads each view, and the
 * current one again when `wake` says it became the newest, since a parked
 * run publishes none. A decision the session refuses to record is tried
 * again briefly, then logged and its request offered again on the next
 * view; a handler still deciding a request that left the view (another
 * surface answered it) is interrupted.
 */
function answerRequests(
  session: RuntimeSessionHandle,
  { host, wake, prompts, superseded }: Approver,
  active: () => boolean,
): Effect.Effect<void> {
  // The handler fiber asked about each request, keyed by run and request
  // as the fold keys a pending request.
  const asked = new Map<string, Fiber.Fiber<void>>();
  const keyOf = (request: PendingRequest): string =>
    `${request.runId}\0${request.requestId}`;
  const forget = (pending: PendingRequest): Effect.Effect<void> =>
    Effect.sync(() => {
      asked.delete(keyOf(pending));
    });
  // The session's one `request.decide`, tried again when its write is
  // refused.
  const record = (
    pending: PendingRequest,
    decision: RequestDecision,
  ): Effect.Effect<void, RequestError> =>
    session.requests
      .request({
        kind: 'request.decide',
        runId: pending.runId,
        requestId: pending.requestId,
        decision,
      })
      .pipe(Effect.retry({ schedule: DECIDE_RETRY, times: 3 }), Effect.asVoid);
  const answer = (pending: PendingRequest): Effect.Effect<void> =>
    decisionOf(host, pending).pipe(
      Effect.flatMap((decision) =>
        // A newer handler attached as this one decided (its prompt is
        // withdrawn on attach; this is the backstop): the newer one answers.
        active()
          ? record(pending, decision)
          : Effect.logWarning(
              `A decision on request ${pending.requestId} came from a handler no longer the newest; the newer one answers it`,
            ).pipe(
              withLogChannel(CHANNEL),
              Effect.andThen(superseded(pending)),
            ),
      ),
      Effect.asVoid,
      // An interrupt is a withdrawal, handled above; anything else is logged.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning(
              `The decision on request ${pending.requestId} was not recorded; it is offered again on the next view`,
            ).pipe(
              Effect.annotateLogs({ data: cause }),
              withLogChannel(CHANNEL),
              Effect.andThen(forget(pending)),
            ),
      ),
    );
  const woken = Stream.fromQueue(wake).pipe(
    Stream.mapEffect(() => SubscriptionRef.get(session.view.ref)),
  );
  return Stream.merge(session.view.changes, woken).pipe(
    Stream.runForEach((view) =>
      Effect.forEach(
        attentionOf(view).requests.filter(
          (pending) =>
            active() &&
            requestParksItsCaller(pending.payload) &&
            !asked.has(keyOf(pending)),
        ),
        (pending) =>
          // One handler awaiting its embedder never holds the next. Held
          // in the map before it starts, so an attach can withdraw it, and
          // forgotten by the fiber's own exit: a withdrawal (asked again
          // should this handler become the newest) or a failure. The exit
          // observer is what makes a prompt withdrawn in the tick it was
          // forked, before its first step ran, forget itself too; a finalizer
          // inside the effect never runs for a fiber that never started, and
          // the key it left behind kept the request from ever being asked
          // again. A decided request stays held until the view drops it, so
          // the fold catching up cannot re-ask it.
          FiberSet.run(prompts, answer(pending), {
            startImmediately: false,
          }).pipe(
            Effect.tap((fiber) =>
              Effect.sync(() => {
                const key = keyOf(pending);
                asked.set(key, fiber);
                fiber.addObserver((exit) => {
                  if (Exit.isFailure(exit) && asked.get(key) === fiber)
                    asked.delete(key);
                });
              }),
            ),
          ),
        { discard: true },
      ).pipe(
        // A request gone from the list is decided for good: a handler still
        // deciding it lost to another surface's decision, so it stops.
        Effect.andThen(
          Effect.suspend(() => {
            const listed = new Set(view.requests.map(keyOf));
            return Effect.forEach(
              [...asked].filter(([id]) => !listed.has(id)),
              ([id, fiber]) => {
                asked.delete(id);
                // Forked: the view loop never waits on an embedder's handler.
                return Effect.forkChild(Fiber.interrupt(fiber));
              },
              { discard: true },
            );
          }),
        ),
      ),
    ),
  );
}

/**
 * Attach `host` to `session` for the caller's scope: the newest host
 * presents, and the newest handler in `approvers` (the session's own list)
 * answers the runs' requests, until the scope or the session closes. A
 * host with a handler can answer whatever its surface says.
 */
export function attachHost(
  session: RuntimeSessionHandle,
  host: SessionHost,
  approvers: Approver[],
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    // The session disposes its hosts as it closes: the answerer ends then.
    const ended = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      session.interactions.use(
        overlay(host, () => Deferred.doneUnsafe(ended, Effect.void)),
      ),
      (detach) => Effect.sync(detach),
    );
    if (!answers(host)) return;
    const self: Approver = {
      host,
      wake: yield* Queue.unbounded<void>(),
      prompts: yield* FiberSet.make<void>(),
      superseded: (pending) =>
        Effect.suspend(
          () =>
            host.emit?.('requestShowInstruction', {
              key: `superseded-${pending.requestId}`,
              message: 'This request was answered in a newer window.',
            }) ?? Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `The older window was not told request ${pending.requestId} went to a newer one`,
            ).pipe(
              Effect.annotateLogs({ data: cause }),
              withLogChannel(CHANNEL),
            ),
          ),
        ),
    };
    // Attaching withdraws the older handler's prompts in flight: the newest
    // asks them again. Leaving wakes the handler that becomes the newest: it
    // re-reads the current view, where a request this one asked still waits.
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const older = approvers.at(-1);
        approvers.push(self);
        if (older !== undefined) yield* FiberSet.clear(older.prompts);
      }),
      () =>
        Effect.suspend(() => {
          approvers.splice(approvers.indexOf(self), 1);
          const next = approvers.at(-1);
          return next === undefined
            ? Effect.void
            : Effect.asVoid(Queue.offer(next.wake, undefined));
        }),
    );
    yield* Effect.forkScoped(
      answerRequests(session, self, () => approvers.at(-1) === self).pipe(
        Effect.raceFirst(Deferred.await(ended)),
        // The session ended: no prompt still out decides against it.
        Effect.ensuring(FiberSet.clear(self.prompts)),
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
