import { Effect, SubscriptionRef } from 'effect';
import { lifecycleParks } from '@agent/runtime/runLaunchGuard';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';

const CHANNEL = 'LeftoverRunSweep';

/** Runs still going: held by this process, or listed by the view as
 *  running or waiting (a run whose owner process died is listed as
 *  interrupted, so it is swept). */
function runningRuns(session: SessionHandle): Set<RunId> {
  const running = new Set(session.runs.get().map((run) => run.runId));
  for (const run of SubscriptionRef.getUnsafe(session.view.ref).runs.values()) {
    if (run.group === 'running' || run.group === 'waiting') running.add(run.id);
  }
  return running;
}

/** Remove the nonresumable background-shell cohort captured before session open. */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(function* (
  session: SessionHandle,
  rows: readonly SessionEvent[],
) {
  const removed = new Set(
    rows
      .filter((row) => row.type === 'run.removed')
      .map((row) => row.aggregateId),
  );
  const running = runningRuns(session);
  // Each run's rows once, so the per-run park check reads only its own.
  const byRun = Map.groupBy(rows, (row) => row.aggregateId);
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
    // A shell parked holding its result for its parent stays until that
    // result is delivered.
    const parks = lifecycleParks(byRun.get(row.aggregateId) ?? [], runId);
    if (parks.some((park) => park.heldFor !== undefined)) continue;
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
