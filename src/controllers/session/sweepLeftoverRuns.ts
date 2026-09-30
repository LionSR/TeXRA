import { Clock, Effect, SubscriptionRef } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type AggregateId,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

const CHANNEL = 'LeftoverRunSweep';

/** How long a conversation stays in the Trash before the sweep removes it. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Runs this process is running right now, by handle or by in-flight phase. */
function runningRuns(session: SessionHandle): Set<RunId> {
  const running = new Set(session.runs.activeIds());
  for (const run of SubscriptionRef.getUnsafe(session.view).runs.values()) {
    if (isInFlightPhase(run.status)) running.add(run.id);
  }
  return running;
}

/**
 * Remove the leftovers of the listing captured before session open: the
 * nonresumable background shells, and the runs whose newest `run.trash`
 * put them in the Trash more than 30 days ago.
 */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(function* (
  session: SessionHandle,
  rows: readonly SessionEvent[],
) {
  const now = yield* Clock.currentTimeMillis;
  const removed = new Set(
    rows
      .filter((row) => row.type === 'run.removed')
      .map((row) => row.aggregateId),
  );
  // Rows come in commit order, so each run's newest `run.trash` decides.
  const expired = new Set<AggregateId>();
  for (const row of rows) {
    if (row.type !== 'run.trash') continue;
    if (row.trashed && now - row.at >= TRASH_RETENTION_MS)
      expired.add(row.aggregateId);
    else expired.delete(row.aggregateId);
  }
  const running = runningRuns(session);
  for (const row of rows) {
    if (
      row.type !== 'run.start' ||
      !(row.identity.kind === 'process' || expired.has(row.aggregateId)) ||
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
            'A leftover run was retained because automatic deletion was refused.',
          ).pipe(
            Effect.annotateLogs({ data: { runId, error } }),
            withLogChannel(CHANNEL),
          ),
        ),
      );
  }
});
