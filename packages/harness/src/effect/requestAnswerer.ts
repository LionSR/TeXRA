/**
 * A host attached to one session of `@texra-ai/worldline`: its presentation
 * surface, and its approval handler at work, which requests it is asked
 * (once each) and what is recorded when it does not answer. A handler that
 * fails or throws denies the request, with the cause logged; one that has not
 * answered yet is waited for, with no deadline.
 */
import {
  Cause,
  Context,
  Duration,
  Effect,
  Fiber,
  FiberMap,
  Option,
  Schedule,
  Schema,
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
import { logFailure, withLogChannel } from '@logger/effectLog';
import { attentionOf } from '@shared/session/sessionView';
import { SessionViewAccess } from '@shared/session/runHistory';
import { answerMismatch, type RequestDecision } from '@shared/schemas';
import type { PendingRequest, SessionView } from '@shared/session/sessionView';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ApprovalHandler, SessionHost } from './sessions.js';

const CHANNEL = 'agentPackage';

/** The approval handler answered with a decision the request's kind does
 *  not take. */
class DecisionMismatch extends Schema.TaggedError<DecisionMismatch>()(
  'DecisionMismatch',
  { message: Schema.String },
) {}

/** How a decision the session did not record is recorded again: after
 *  100 ms, doubling and jittered, each wait at most 30 s. With
 *  {@link DECIDE_RETRIES} it ends after about two and a half minutes. */
const DECIDE_RETRY = Schedule.exponential('100 millis').pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
const DECIDE_RETRIES = 12;

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
        : Effect.fail(new DecisionMismatch({ message: mismatch }));
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : logFailure(
            CHANNEL,
            `The approval handler gave no usable decision on request ${pending.requestId}; it is denied`,
          )(cause).pipe(
            Effect.as<RequestDecision>({
              action: 'deny',
              reason: `The approval handler gave no usable decision: ${toErrorMessage(cause)}`,
            }),
          ),
    ),
  );

/**
 * Run `program` once for each request `select` picks from the session's
 * view, for as long as the view lists it. A program holds its request (a
 * decision, a preview, a staged card) by ending with `Effect.never`, and
 * releases it in a finalizer, which runs once the view drops the request,
 * however it was decided. One that returns runs again on the next view that
 * still lists its request, an event that may not come: a program that must
 * try again does so on its own schedule.
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
 * every host reads), once, through the session's one `request.decide`. The
 * handler is asked once for a request. A decision the session does not
 * record is recorded again on {@link DECIDE_RETRY}, for as long as the view
 * lists the request (one decided meanwhile, by a grant or another surface,
 * leaves the view, which ends the retries); when the retries end it is
 * logged, the person is told (the host's error notice), and the request
 * stays open, to be decided by another
 * surface or ended with its run. A handler still deciding a request that
 * left the view is interrupted.
 */
const answerRequests = (
  session: Context.Context<SessionServices>,
  host: AnsweringHost,
): Effect.Effect<void, never, Scope.Scope> =>
  followPendingRequests(
    Context.get(session, SessionViewAccess),
    (view) => attentionOf(view).requests,
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
              // The session took no decision: decided meanwhile, a run no
              // fiber here drives, or a write it refused.
              Effect.tapError((error) =>
                Effect.logInfo(
                  `The decision on request ${pending.requestId} was not recorded; recording it again: ${toErrorMessage(error)}`,
                ).pipe(withLogChannel(CHANNEL)),
              ),
              Effect.retry({ schedule: DECIDE_RETRY, times: DECIDE_RETRIES }),
            ),
        ),
        // A decision the retries did not record is logged and told to the
        // person who gave it, once. An interrupt, a withdrawal, passes.
        Effect.catch((error) =>
          logFailure(
            CHANNEL,
            `The decision on request ${pending.requestId} was not recorded after ${DECIDE_RETRIES} retries; the request stays open`,
          )(error).pipe(
            Effect.andThen(
              Context.get(session, Interactions).emit('requestShowError', {
                message: `Your answer to a request of run ${pending.runId} could not be recorded (${toErrorMessage(error)}). The request is still open, and is not asked again here: stop the run if nothing else can answer it.`,
              }),
            ),
          ),
        ),
        // The request is held until the view drops it, so the handler is
        // never asked twice: a recorded decision while the view catches
        // up, an unrecorded one until another surface decides it or its
        // run ends.
        Effect.andThen(Effect.never),
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
