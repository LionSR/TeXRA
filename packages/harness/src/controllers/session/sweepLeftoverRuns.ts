import { Effect, SubscriptionRef } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

const CHANNEL = 'LeftoverRunSweep';

/** Runs this process is running right now, by handle or by in-flight phase. */
function runningRuns(session: SessionHandle): Set<RunId> {
  const running = new Set(session.runs.activeIds());
  for (const run of SubscriptionRef.getUnsafe(session.view.ref).runs.values()) {
    if (isInFlightPhase(run.status)) running.add(run.id);
  }
  return running;
}

/** Remove the nonresumable background-shell cohort captured before session open. */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(function* (
  session: SessionHandle,
  rows: readonly SessionEvent[],
) {
  // A shell parked holding its result for its parent (no end after the
  // park) stays until that result is delivered.
  const ended = new Map(
    rows.flatMap((row) =>
      row.type === 'run.end' ? [[row.aggregateId, row.commit] as const] : [],
    ),
  );
  const removed = new Set(
    rows
      .filter(
        (row) =>
          row.type === 'run.removed' ||
          (row.type === 'child.park' &&
            row.heldFor !== undefined &&
            (ended.get(row.aggregateId) ?? 0) < row.commit),
      )
      .map((row) => row.aggregateId),
  );
  const running = runningRuns(session);
  for (const row of rows) {
    if (
      row.type !== 'run.start' ||
      row.identity.kind !== 'process' ||
      removed.has(row.aggregateId)
    )
      continue;
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run') continue;
    const runId = target.id;
    if (running.has(runId)) continue;
    yield* session.requests
      .removeRun(runId, 'automatic', row.commit)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            'A background shell was retained because automatic deletion was refused.',
          ).pipe(
            Effect.annotateLogs({ data: { runId, error } }),
            withLogChannel(CHANNEL),
          ),
        ),
      );
  }
});
