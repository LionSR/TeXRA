import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import { type FlowSnapshotPayload, type RunId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getRunRecords } from './runRecords';

const CHANNEL = 'Resumability';
const log = createLog(CHANNEL);

/**
 * What the durable run facts alone say about continuing a run: a
 * `flow.snapshot` exists on the run aggregate, nothing is left to resume, or
 * the storage itself could not be read (reported with its cause, which is
 * display text, never guessed).
 */
export type ResumabilityDecision =
  | { readonly kind: 'checkpoint'; readonly snapshot: FlowSnapshotPayload }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly cause: string };

/**
 * Single storage-owned resumability decision.
 *
 * A checkpoint means exactly one thing: the run aggregate carries a
 * `flow.snapshot`, read through the indexed latest-snapshot read. The
 * terminal record is read only to prove the run's metadata is readable at
 * all: the outcome never blocks, because rows live until explicit deletion
 * (C9), so a failed or cancelled run is offered as "continue from its last
 * snapshot". Ownership is not decided here; `classifyRun`
 * (`@agent/runtime/runClassification`) combines this decision with the run
 * claim.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<ResumabilityDecision> {
  const endResult = yield* getRunRecords(session, runId)
    .readRunEnd()
    .pipe(Effect.result);
  if (endResult._tag === 'Failure') {
    const error = endResult.failure;
    yield* Effect.logDebug(
      `Failed to read the terminal record for ${runId}: ${toErrorMessage(error)}`,
    ).pipe(withLogChannel(CHANNEL));
    return {
      kind: 'unreadable',
      cause: `run metadata could not be read (${toErrorMessage(error)})`,
    };
  }
  const snapshot = yield* session.ledger
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
  return { kind: 'none' };
});

/**
 * Whether a run has a `flow.snapshot` to continue from: one indexed read,
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
  return yield* session.ledger.latestSnapshot(runId).pipe(
    Effect.map((snapshot) => snapshot !== null),
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn(
          `Could not read the checkpoint of ${runId}: ${toErrorMessage(error)}`,
          { data: error },
        );
        return false;
      }),
    ),
  );
});
