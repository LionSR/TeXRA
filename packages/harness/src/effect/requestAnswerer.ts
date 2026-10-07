/**
 * The embedder's approval handler at work on one session of
 * `@texra-ai/harness`: which requests it is asked, once each, and what is
 * recorded when it does not answer. A request is never left parked on a
 * handler that failed, threw, or went quiet: that is a denial, with the
 * cause logged.
 */
import { Cause, Deferred, Duration, Effect, Stream } from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { requestParksItsCaller, type RequestDecision } from '@shared/schemas';
import { attentionOf } from '@shared/session/sessionView';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ApprovalHandler, PendingRequest } from './sessions.js';

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
 * Answer the runs' requests of `session` with `approve` until `ended`:
 * every request a parked run waits on here (the attention rule every host
 * reads), once, through the session's one `request.decide`. A decision the
 * session refuses to record is logged and its request offered again on the
 * next view.
 */
export function answerRequests(
  session: RuntimeSessionHandle,
  approve: ApprovalHandler,
  ended: Deferred.Deferred<void>,
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
    Stream.interruptWhen(Deferred.await(ended)),
    Stream.runForEach((view) =>
      Effect.forEach(
        attentionOf(view).requests.filter(
          (pending) =>
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
