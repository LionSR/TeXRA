import { Effect, Fiber, Stream } from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import type { ProcessRuntime } from '@platform/processRuntime';
import { aggregateTarget, type AddOutputFilesPayload } from '@shared/schemas';
import { goalStateChanges, type GoalStateChange } from '@tools/goal';

/** Read the output files each durable output row owns. */
export function subscribeOutputFiles(
  session: Pick<SessionHandle, 'events' | 'now'>,
  listener: (payload: AddOutputFilesPayload) => void,
  runtime: ProcessRuntime,
): () => void {
  const fiber = runtime.runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'output.produced') return;
        const target = aggregateTarget(event.aggregateId);
        if (target.kind !== 'run') return;
        listener({
          runId: target.id,
          filesByRound: Object.fromEntries(
            event.rounds.map((round) => [round.round, round.outputs]),
          ),
        });
      }),
    ),
  );
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
}

/** Read a session's goal-state changes from now on. */
export function subscribeGoalStateChanges(
  session: Pick<SessionHandle, 'folded' | 'now'>,
  listener: (change: GoalStateChange) => void,
  runtime: ProcessRuntime,
): () => void {
  const fiber = runtime.runFork(
    Stream.runForEach(goalStateChanges(session), (change) =>
      Effect.sync(() => listener(change)),
    ),
  );
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
}
