/**
 * A host attached to one session of `@texra-ai/harness`: its presentation
 * surface, and its approval handler at work, which requests it is asked
 * (once each) and what is recorded when it does not answer. A request is
 * never left parked on a handler that failed, threw, or went quiet: that is
 * a denial, with the cause logged.
 */
import { Cause, Deferred, Duration, Effect, type Scope, Stream } from 'effect';

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

/**
 * Answer the runs' requests of `session` with `approve` while it is the
 * newest attached handler (`active`), until interrupted: every request a
 * parked run waits on here (the attention rule every host reads), once,
 * through the session's one `request.decide`. A decision the session
 * refuses to record is logged and its request offered again on the next
 * view.
 */
function answerRequests(
  session: RuntimeSessionHandle,
  approve: ApprovalHandler,
  active: () => boolean,
): Effect.Effect<void> {
  // Keyed by run and request, as the fold keys a pending request.
  const acted = new Set<string>();
  const keyOf = (request: PendingRequest): string =>
    `${request.runId}\0${request.requestId}`;
  const answer = (pending: PendingRequest): Effect.Effect<void> =>
    decisionOf(approve, pending).pipe(
      Effect.flatMap((decision) =>
        session.requests.request({
          kind: 'request.decide',
          runId: pending.runId,
          requestId: pending.requestId,
          decision,
        }),
      ),
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
  return session.view.changes.pipe(
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
          // One handler awaiting its embedder never holds the next.
          return Effect.forkChild(answer(pending));
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
  approvers: ApprovalHandler[],
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
    yield* Effect.acquireRelease(
      Effect.sync(() => approvers.push(approve)),
      () => Effect.sync(() => approvers.splice(approvers.indexOf(approve), 1)),
    );
    yield* Effect.forkScoped(
      answerRequests(session, approve, () => approvers.at(-1) === approve).pipe(
        Effect.raceFirst(Deferred.await(ended)),
      ),
    );
  });
}
