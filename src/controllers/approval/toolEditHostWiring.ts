/**
 * The two wiring points a windowed host connects one
 * {@link ToolEditApprovalController} through: the session's interaction port
 * (a request that opens stages a preview; one whose `request.opened` never
 * commits releases it) and the follower that releases a preview when its
 * request is decided, by any surface. The extension and the desktop each
 * copied both; the host keeps only the controller it builds, the fiber
 * scheme it forks on, and when it disposes.
 */
import { Cause, Effect, Stream } from 'effect';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';

import type { ToolEditApprovalController } from './ToolEditApprovalController';

const CHANNEL = 'ToolEditApproval';

/**
 * The tool-edit members of `session.interactions.use`. Staging runs on the
 * host's own fiber scheme (`spawn`): the session hands the request over and
 * does not wait, and a staging failure is logged here rather than left to a
 * fiber nobody reads. The release is composed into the session's own program
 * rather than run here, so the session waits for the diff view and the temp
 * files behind it to go; the controller's programs take the host's services
 * from the runtime's context, which the session that composes them does not
 * carry.
 */
export function toolEditInteractions(
  controller: ToolEditApprovalController,
  runtime: ProcessRuntime,
  spawn: (program: Effect.Effect<void, never, ProcessServices>) => void,
): Required<Pick<HostInteractions, 'presentToolEdit' | 'releaseToolEdit'>> {
  return {
    presentToolEdit: (request) =>
      spawn(
        controller
          .present(request)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError('Failed to stage the tool-edit preview').pipe(
                Effect.annotateLogs({ data: Cause.squash(cause) }),
                withLogChannel(CHANNEL),
              ),
            ),
          ),
      ),
    releaseToolEdit: (requestId) =>
      withProcessServices(runtime, controller.release(requestId)),
  };
}

/**
 * Release each staged preview as its request is decided. Total: a failed
 * event read is logged, not left to end the fiber silently with every staged
 * preview waiting on a `request.decided`.
 */
export function followToolEditDecisions(
  session: SessionHandle,
  runtime: ProcessRuntime,
  controller: ToolEditApprovalController,
): Effect.Effect<void> {
  return withProcessServices(
    runtime,
    Stream.runForEach(session.events.all(session.now()), (event) =>
      controller.handleSessionEvent(event),
    ),
  ).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(
            'The tool-edit follower stopped; staged previews are released only on dispose',
          ).pipe(
            Effect.annotateLogs({ data: Cause.squash(cause) }),
            withLogChannel(CHANNEL),
          ),
    ),
  );
}
