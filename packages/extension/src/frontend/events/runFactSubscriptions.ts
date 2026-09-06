import { Effect, Fiber, Stream } from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import { aggregateTarget, type AddOutputFilesPayload } from '@shared/schemas';

/** Read a session's `addOutputFiles` facts from now on. */
export function subscribeAddOutputFilesRunFact(
  session: Pick<SessionHandle, 'events' | 'now'>,
  listener: (payload: AddOutputFilesPayload) => void,
): () => void {
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'addOutputFiles') return;
        listener({
          streamId: aggregateTarget(event.aggregateId).id,
          filesByRound: event.filesByRound,
        });
      }),
    ),
  );
  return () => {
    effectRuntime().runFork(Fiber.interrupt(fiber));
  };
}
