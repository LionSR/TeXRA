/**
 * What both GUI hosts attach to a session for the life of their window: the
 * tool-edit preview its controller stages, and what the host presents
 * itself (`interactions`). The session hands `presentToolEdit` its request
 * and does not wait. That request and the events the session commits drain
 * into the controller through one queue, in the order they arrived, so a
 * decided request releases its preview whichever surface decided it. The
 * host closes the scope to detach.
 */
import { Cause, Effect, Queue, type Scope, Stream } from 'effect';

import { withLogChannel } from '@texra-ai/harness/host';
import type { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import type { LocalSession } from '@texra-ai/harness';
import type {
  ToolEditApprovalRequest,
  HostInteractions,
} from '@texra-ai/harness/host';
import type { DisplaySessionEvent } from '@texra-ai/harness/schemas';

const CHANNEL = 'SessionHost';

type PreviewServices = Effect.Services<
  ReturnType<ToolEditApprovalController['dispose']>
>;

/** What reaches the controller, in arrival order. A request is handed over
 *  before its `request.opened` commits, so its staging is queued ahead of
 *  the `request.decided` that releases it. */
type HostJob =
  | { readonly stage: ToolEditApprovalRequest }
  | { readonly event: DisplaySessionEvent };

export const attachSessionHost = Effect.fn('session.attachHost')(function* (
  session: LocalSession,
  controller: ToolEditApprovalController,
  interactions: Omit<
    HostInteractions,
    'presentToolEdit' | 'releaseToolEdit' | 'approveToolEdit'
  >,
): Effect.fn.Return<void, never, Scope.Scope | PreviewServices> {
  const services = yield* Effect.context<PreviewServices>();
  const jobs = yield* Queue.unbounded<HostJob>();
  // A staging starts immediately, so its entry is installed before the next
  // job runs; a decision handled first would find no entry to release and
  // leave the preview it then staged open. A staging failure is logged here:
  // the request stays open in the fold, and the surface's decision answers
  // it from the payload.
  yield* Effect.forkScoped(
    Stream.fromQueue(jobs).pipe(
      Stream.runForEach((job) =>
        'event' in job
          ? controller.handleSessionEvent(job.event)
          : Effect.forkScoped(
              controller
                .present(job.stage)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      'Failed to stage the tool-edit preview',
                    ).pipe(
                      Effect.annotateLogs({ data: Cause.squash(cause) }),
                      withLogChannel(CHANNEL),
                    ),
                  ),
                ),
              { startImmediately: true },
            ),
      ),
    ),
    { startImmediately: true },
  );
  // Total: a failed event read is logged, not left to end this fiber with
  // every staged preview waiting on a `request.decided`.
  yield* Effect.forkScoped(
    Stream.runForEach(session.view.events(session.view.head()), (event) =>
      Queue.offer(jobs, { event }),
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
  yield* session.attach({
    ...interactions,
    presentToolEdit: (request) => {
      Queue.offerUnsafe(jobs, { stage: request });
    },
    // The release is composed into the session's own program, which does
    // not carry this window's services: they are the ones captured here.
    releaseToolEdit: (requestId) =>
      Effect.provideContext(controller.release(requestId), services),
    // An approve-all reaches the edits a user made in a staged diff view.
    approveToolEdit: (requestId) =>
      Effect.provideContext(controller.approveStaged(requestId), services),
  });
});
