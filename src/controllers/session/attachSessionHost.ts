/**
 * What both GUI hosts attach to a session for the life of their window: the
 * tool-edit preview its controller stages, and what the host presents itself
 * (`extras`). The session hands `presentToolEdit` its request and does not
 * wait; the request is staged on a fiber of the caller's scope. The events
 * the session commits drain into the controller, so a decided request
 * releases its preview whichever surface decided it, and into the host's own
 * `onEvent`. The host closes the scope to detach.
 */
import { Cause, Effect, Queue, type Scope, Stream } from 'effect';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { withLogChannel } from '@logger/effectLog';
import type { SessionEvent } from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

const CHANNEL = 'SessionHost';

type PreviewServices = Effect.Services<
  ReturnType<ToolEditApprovalController['dispose']>
>;

export const attachSessionHost = Effect.fn('session.attachHost')(function* (
  session: SessionHandle,
  controller: ToolEditApprovalController,
  extras: Omit<HostInteractions, 'presentToolEdit' | 'releaseToolEdit'> & {
    readonly onEvent?: (event: SessionEvent) => Effect.Effect<void>;
  },
): Effect.fn.Return<void, never, Scope.Scope | PreviewServices> {
  const { onEvent, ...interactions } = extras;
  const services = yield* Effect.context<PreviewServices>();
  const stagings = yield* Queue.unbounded<ToolEditApprovalRequest>();
  // A staging failure is logged here: the request stays open in the fold, and
  // the surface's decision answers it from the payload.
  yield* Effect.forkScoped(
    Stream.fromQueue(stagings).pipe(
      Stream.runForEach((request) =>
        Effect.forkScoped(
          controller
            .present(request)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning('Failed to stage the tool-edit preview').pipe(
                  Effect.annotateLogs({ data: Cause.squash(cause) }),
                  withLogChannel(CHANNEL),
                ),
              ),
            ),
        ),
      ),
    ),
    { startImmediately: true },
  );
  // Total: a failed event read is logged, not left to end this fiber with
  // every staged preview waiting on a `request.decided`.
  yield* Effect.forkScoped(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      controller
        .handleSessionEvent(event)
        .pipe(Effect.andThen(onEvent?.(event) ?? Effect.void)),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(
              'The tool-edit follower stopped; staged previews are released only on window close',
            ).pipe(
              Effect.annotateLogs({ data: Cause.squash(cause) }),
              withLogChannel(CHANNEL),
            ),
      ),
    ),
    { startImmediately: true },
  );
  yield* Effect.acquireRelease(
    session.interactions.use({
      ...interactions,
      presentToolEdit: (request) => {
        Queue.offerUnsafe(stagings, request);
      },
      // The release is composed into the session's own program, which does
      // not carry this window's services: they are the ones captured here.
      releaseToolEdit: (requestId) =>
        Effect.provideContext(controller.release(requestId), services),
    }),
    (detach) => Effect.sync(detach),
  );
});
