/**
 * A host attached to one session of `@texra-ai/harness`: its presentation
 * surface, and its approval handler at work, which requests it is asked
 * (once each) and what is recorded when it does not answer. A handler that
 * fails or throws denies the request, with the cause logged; one that has not
 * answered yet is waited for, with no deadline.
 */
import {
  Cause,
  Context,
  Effect,
  Fiber,
  FiberMap,
  Option,
  Schedule,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  attachInteractions,
  Interactions,
  type HostInteractions,
} from '@agent/runtime/HostInteractions';
import { SessionRequests } from '@agent/runtime/requests';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { withLogChannel } from '@logger/effectLog';
import { attentionOf } from '@shared/session/sessionView';
import { SessionViewAccess } from '@shared/session/runHistory';
import {
  answerMismatch,
  blocksCaller,
  type RequestDecision,
} from '@shared/schemas';
import { Unavailable } from '@shared/session/runtimeRequest';
import type {
  PendingRequest,
  SessionView,
} from '@shared/session/readonlyViews';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ApprovalHandler, SessionHost } from './sessions.js';

const CHANNEL = 'agentPackage';

/** How a decision the session refused to record is tried again, briefly,
 *  before the next view offers its request again. */
const DECIDE_RETRY = Schedule.exponential('100 millis').pipe(Schedule.jittered);

/** The handler's decision on `pending`, or a denial naming why it gave
 *  none it can use: a failure, a throw, or a decision the request's kind
 *  does not take. It waits as long as the handler does: a person's prompt
 *  carries its own deadline, or none. A withdrawal (the prompt
 *  interrupted) stays one: it is no decision at all. */
const decisionOf = (
  host: AnsweringHost,
  pending: PendingRequest,
): Effect.Effect<RequestDecision> =>
  // Called on the host itself: a class-based host keeps its receiver.
  Effect.suspend(() => host.approve(pending)).pipe(
    Effect.flatMap((decision) => {
      const mismatch = answerMismatch(pending, decision);
      return mismatch === null
        ? Effect.succeed(decision)
        : Effect.fail(new Error(mismatch));
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(
            `The approval handler gave no usable decision on request ${pending.requestId}; it is denied`,
          ).pipe(
            Effect.annotateLogs({ data: cause }),
            withLogChannel(CHANNEL),
            Effect.as<RequestDecision>({
              action: 'deny',
              reason: `The approval handler gave no usable decision: ${toErrorMessage(Cause.squash(cause))}`,
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
export const followPendingRequests = Effect.fn('followPendingRequests')(
  function* <P extends PendingRequest, R>(
    view: { readonly changes: Stream.Stream<SessionView> },
    select: (view: SessionView) => readonly P[],
    program: (request: P) => Effect.Effect<void, never, R>,
  ): Effect.fn.Return<void, never, R | Scope.Scope> {
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
  },
);

/**
 * Answer the runs' requests of `session` with the host's `approve`, until
 * interrupted: every request a waiting run waits on here (the attention rule
 * every host reads), once, through the session's one `request.decide`. A
 * decision the session refuses to record is tried again briefly, then said
 * and its request offered again on the next view that still lists it (one
 * decided meanwhile, by a grant or another surface, has left the view); a
 * handler still deciding a request that left the view is interrupted.
 */
const answerRequests = (
  session: Context.Context<SessionServices>,
  host: AnsweringHost,
): Effect.Effect<void, never, Scope.Scope> =>
  followPendingRequests(
    Context.get(session, SessionViewAccess),
    (view) =>
      attentionOf(view).requests.filter((pending) =>
        blocksCaller(pending.payload),
      ),
    (pending) =>
      decisionOf(host, pending).pipe(
        Effect.flatMap((decision) =>
          Context.get(session, SessionRequests)
            .request({
              kind: 'request.decide',
              runId: pending.runId,
              requestId: pending.requestId,
              decision,
            })
            .pipe(
              Effect.provide(session),
              Effect.retry({ schedule: DECIDE_RETRY, times: 3 }),
              Effect.as(true),
              // The session took no decision: decided meanwhile, a run no
              // fiber here drives, or a write it refused.
              Effect.catchIf(
                (error) => error instanceof Unavailable,
                (error) =>
                  Effect.logInfo(
                    `The decision on request ${pending.requestId} was not recorded: ${error.reason}`,
                  ).pipe(withLogChannel(CHANNEL), Effect.as(false)),
              ),
            ),
        ),
        // A recorded decision stays held until the view drops its request,
        // so the fold catching up cannot re-ask it; one not recorded ends
        // here, asked again on the next view that still lists it.
        Effect.flatMap((recorded) => (recorded ? Effect.never : Effect.void)),
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
export const attachHost = Effect.fn('attachHost')(function* (
  session: Context.Context<SessionServices>,
  host: SessionHost,
): Effect.fn.Return<void, never, Scope.Scope> {
  const interactions = Context.get(session, Interactions);
  yield* attachInteractions(interactions, overlay(host));
  if (!answers(host)) return;
  // The session detaches its host as it closes: the answerer ends then, and
  // closing its scope interrupts every prompt still out, so none decides
  // against it.
  yield* Effect.forkScoped(
    Effect.scoped(answerRequests(session, host)).pipe(
      Effect.raceFirst(
        SubscriptionRef.changes(interactions.host).pipe(
          Stream.filter(Option.isNone),
          Stream.runHead,
        ),
      ),
    ),
  );
});

/** A host that answers the runs' requests. */
type AnsweringHost = SessionHost & { readonly approve: ApprovalHandler };

const answers = (host: SessionHost): host is AnsweringHost =>
  host.approve !== undefined;

/**
 * `host` as the session's attachment sees it: its presentation members,
 * bound to it (a class-based host keeps its prototype's methods and private
 * state), and, for a host that answers, `approvalPromptsUnavailable: false`.
 */
function overlay(host: SessionHost): HostInteractions {
  return {
    ...(host.emit && { emit: host.emit.bind(host) }),
    approvalPromptsUnavailable: answers(host)
      ? false
      : host.approvalPromptsUnavailable === true,
  };
}
