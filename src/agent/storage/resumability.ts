import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  isPlainAgentIdentity,
  type RunSnapshotPayload,
  type RunId,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { runEndFromEvents } from './runRecords';

const CHANNEL = 'Resumability';

/**
 * What the durable run facts alone say about continuing a run: a
 * `run.snapshot` exists on the run aggregate, the run was never opened,
 * nothing is left to resume, or
 * the storage itself could not be read (reported with its cause, which is
 * display text, never guessed).
 */
export type ResumabilityDecision =
  | { readonly kind: 'checkpoint'; readonly snapshot: RunSnapshotPayload }
  /** Registered, not ended, and never opened: its launch stopped between
   *  the registration and the opening batch. A run the loop drives (a
   *  native agent's, a background script's) opens from its configuration,
   *  so it resumes by opening. */
  | { readonly kind: 'unopened' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly cause: string };

/**
 * Single storage-owned resumability decision.
 *
 * A checkpoint means exactly one thing: the run aggregate carries a
 * `run.snapshot`, read through the indexed latest-snapshot read. The run's
 * records (never its whole aggregate, which the resume's claim reads once)
 * prove its metadata readable and say whether a run without one is
 * `unopened`. The terminal outcome of a checkpointed run never blocks,
 * because rows live until explicit deletion
 * (C9), so a failed or cancelled run is offered as "continue from its last
 * snapshot". Ownership is not decided here; `classifyRun`
 * (`@agent/runtime/runClassification`) combines this decision with the run
 * claim.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<ResumabilityDecision> {
  const records = yield* session.readRunRecords(runId).pipe(Effect.result);
  if (records._tag === 'Failure') {
    const error = records.failure;
    yield* Effect.logDebug(
      `Failed to read the run records for ${runId}: ${toErrorMessage(error)}`,
    ).pipe(withLogChannel(CHANNEL));
    return {
      kind: 'unreadable',
      cause: `run metadata could not be read (${toErrorMessage(error)})`,
    };
  }
  const snapshot = yield* session.runHistory
    .latestSnapshot(runId)
    .pipe(Effect.result);
  if (snapshot._tag === 'Failure') {
    const error = snapshot.failure;
    yield* Effect.logDebug(
      `Failed to read the latest snapshot for ${runId}: ${toErrorMessage(error)}`,
    ).pipe(withLogChannel(CHANNEL));
    return {
      kind: 'unreadable',
      cause: `checkpoint could not be read (${toErrorMessage(error)})`,
    };
  }
  if (snapshot.success !== null) {
    return { kind: 'checkpoint', snapshot: snapshot.success.payload };
  }
  // A process or an external CLI drives its own run and records no opening;
  // the runs the loop opens are those the fold offers a resume
  // (`resumeEligible`).
  const start = records.success.find((row) => row.type === 'run.start');
  if (
    start?.type === 'run.start' &&
    (isPlainAgentIdentity(start.identity) ||
      start.identity.kind === 'script') &&
    runEndFromEvents(records.success, runId) === null
  )
    return { kind: 'unopened' };
  return { kind: 'none' };
});

/**
 * Whether a run has a `run.snapshot` to continue from: one indexed read,
 * never a fold.
 *
 * A probe that fails answers "no checkpoint" and says so at `warn` with the
 * run it belongs to: a listing must still show the row it can read from
 * meta and record rather than dropping the run out of history, and the open
 * path folds the run and refuses there if it disagrees.
 */
export const checkpointExists = Effect.fn('checkpointExists')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<boolean> {
  return yield* session.runHistory.latestSnapshot(runId).pipe(
    Effect.map((snapshot) => snapshot !== null),
    Effect.catch((error) =>
      Effect.logWarning(
        `Could not read the checkpoint of ${runId}: ${toErrorMessage(error)}`,
      ).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as(false),
      ),
    ),
  );
});
