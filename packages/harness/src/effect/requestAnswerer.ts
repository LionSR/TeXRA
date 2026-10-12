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
  FiberSet,
  Queue,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { requestParksItsCaller, type RequestDecision } from '@shared/schemas';
import { attentionOf } from '@shared/session/sessionView';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type {
  ApprovalHandler,
  PendingRequest,
  SessionHost,
} from './sessions.js';

const CHANNEL = 'agentPackage';

/** How long the handler has to answer one request before it is denied. */
const APPROVAL_HANDLER_TIMEOUT = Duration.minutes(10);

/** The handler's decision on `pending`, or a denial naming why it gave
 *  none: a failure, a throw, or no answer in time. */
const decisionOf = (
  approve: ApprovalHandler,
  pending: PendingRequest,
): Effect.Effect<RequestDecision> =>
  Effect.suspend(() => approve(pending)).pipe(
    Effect.timeout(APPROVAL_HANDLER_TIMEOUT),
    Effect.catchCause((cause) =>
      Effect.logWarning(
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
  readonly approve: ApprovalHandler;
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
 * run publishes none. A decision the session refuses to record is logged
 * and its request offered again on the next view.
 */
function answerRequests(
  session: RuntimeSessionHandle,
  { approve, wake, prompts, superseded }: Approver,
  active: () => boolean,
): Effect.Effect<void> {
  // Keyed by run and request, as the fold keys a pending request.
  const acted = new Set<string>();
  const keyOf = (request: PendingRequest): string =>
    `${request.runId}\0${request.requestId}`;
  const answer = (pending: PendingRequest): Effect.Effect<void> =>
    decisionOf(approve, pending).pipe(
      Effect.flatMap((decision) =>
        // A newer handler attached as this one decided (its prompt is
        // withdrawn on attach; this is the backstop): the newer one answers.
        active()
          ? session.requests.request({
              kind: 'request.decide',
              runId: pending.runId,
              requestId: pending.requestId,
              decision,
            })
          : Effect.logWarning(
              `A decision on request ${pending.requestId} came from a handler no longer the newest; the newer one answers it`,
            ).pipe(
              withLogChannel(CHANNEL),
              Effect.andThen(superseded(pending)),
            ),
      ),
      // Withdrawn: asked again should this handler become the newest.
      Effect.onInterrupt(() => Effect.sync(() => acted.delete(keyOf(pending)))),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `The decision on request ${pending.requestId} was not recorded; it is offered again on the next view`,
        ).pipe(
          Effect.annotateLogs({ data: cause }),
          withLogChannel(CHANNEL),
          Effect.andThen(Effect.sync(() => acted.delete(keyOf(pending)))),
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
            !acted.has(keyOf(pending)),
        ),
        (pending) => {
          acted.add(keyOf(pending));
          // One handler awaiting its embedder never holds the next. Held
          // in the set before it starts, so an attach can withdraw it.
          return FiberSet.run(prompts, answer(pending), {
            startImmediately: false,
          });
        },
        { discard: true },
      ).pipe(
        // A request gone from the list is decided for good: forget it.
        Effect.andThen(
          Effect.sync(() => {
            const listed = new Set(view.requests.map(keyOf));
            for (const id of acted) if (!listed.has(id)) acted.delete(id);
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
  { approve, ...interactions }: SessionHost,
  approvers: Approver[],
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    // The session disposes its hosts as it closes: the answerer ends then.
    const ended = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      session.interactions.use({
        ...interactions,
        ...(approve && { approvalPromptsUnavailable: false }),
        dispose: () => Deferred.doneUnsafe(ended, Effect.void),
      }),
      (detach) => Effect.sync(detach),
    );
    if (approve === undefined) return;
    const self: Approver = {
      approve,
      wake: yield* Queue.unbounded<void>(),
      prompts: yield* FiberSet.make<void>(),
      superseded: (pending) =>
        Effect.suspend(
          () =>
            interactions.emit?.('requestShowInstruction', {
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
      ),
    );
  });
}
