import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import {
  aggregateTarget,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

const log = createLog('LeftoverRunSweep');

/** Streams this process is running right now, by handle or by in-flight phase. */
function runningRuns(session: SessionHandle): Set<RunId> {
  const running = new Set<RunId>();
  for (const handle of session.runs.getAgentHandles()) {
    running.add(handle.runId);
  }
  for (const [stream, state] of session.status.getAllStreamStates()) {
    if (isInFlightPhase(state.phase)) running.add(stream);
  }
  return running;
}

/** Remove the nonresumable background-shell cohort captured before session open. */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(
  function* (session: SessionHandle, rows: readonly SessionEvent[]) {
    const removed = new Set(
      rows
        .filter((row) => row.type === 'run.removed')
        .map((row) => row.aggregateId),
    );
    const running = runningRuns(session);
    for (const row of rows) {
      if (
        row.type !== 'run.start' ||
        row.identity?.kind !== 'process' ||
        removed.has(row.aggregateId)
      )
        continue;
      const target = aggregateTarget(row.aggregateId);
      if (target.kind !== 'run') continue;
      const stream = target.id;
      if (running.has(stream)) continue;
      yield* session.requests
        .removeRun(stream, 'automatic', row.commit)
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                'A background shell was retained because automatic deletion was refused.',
                { data: { stream, error } },
              );
            }),
          ),
        );
    }
  },
);
