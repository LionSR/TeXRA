import { Effect } from 'effect';
import { z } from 'zod';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import {
  type FlowSnapshotPayload,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getRunRecords } from './runRecords';

const log = createLog('Resumability');

/**
 * Which durable fact was unreadable. The checkpoint's own content is never
 * judged here: `RunLedger.load` refuses a run whose rows do not fold, at the
 * one place that acts on them. Callers discriminate on this, never on
 * {@link ResumabilityDecision.cause}, which is display text.
 */
export type ResumabilityFault =
  'metadata-unreadable' | 'metadata-malformed' | 'checkpoint-unreadable';

/**
 * What the durable run facts alone say about continuing a run: a
 * `flow.snapshot` exists on the run aggregate, nothing is left to resume, or
 * the storage itself could not be read (reported with its cause, never
 * guessed).
 */
export type ResumabilityDecision =
  | {
      readonly kind: 'checkpoint';
      readonly snapshot: FlowSnapshotPayload;
      readonly outcome?: RunOutcome;
    }
  | {
      readonly kind: 'none';
      readonly outcome?: RunOutcome;
    }
  | {
      readonly kind: 'unreadable';
      readonly cause: string;
      readonly fault: ResumabilityFault;
    };

/**
 * Single storage-owned resumability decision.
 *
 * A checkpoint means exactly one thing: the run aggregate carries a
 * `flow.snapshot`, read through the indexed latest-snapshot read. The
 * terminal outcome is read and reported on the decision for display, but it
 * never blocks: rows live until explicit deletion (C9), so a failed or
 * cancelled run is offered as "continue from its last snapshot". Ownership
 * is not decided here; `classifyRun` (`@agent/runtime/runClassification`)
 * combines this decision with the run claim.
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
    const malformed = error instanceof z.ZodError;
    log.debug(
      `Failed to read the terminal record for ${runId}: ${toErrorMessage(error)}`,
    );
    return {
      kind: 'unreadable',
      fault: malformed ? 'metadata-malformed' : 'metadata-unreadable',
      cause: malformed
        ? 'run metadata is malformed'
        : `run metadata could not be read (${toErrorMessage(error)})`,
    };
  }
  const outcome = endResult.success?.outcome;
  const metaFields = outcome === undefined ? {} : { outcome };
  const snapshot = yield* session.ledger
    .latestSnapshot(runId)
    .pipe(Effect.result);
  if (snapshot._tag === 'Failure') {
    const error = snapshot.failure;
    log.debug(
      `Failed to read the latest snapshot for ${runId}: ${toErrorMessage(error)}`,
    );
    return {
      kind: 'unreadable',
      fault: 'checkpoint-unreadable',
      cause: `checkpoint could not be read (${toErrorMessage(error)})`,
    };
  }
  if (snapshot.success !== null) {
    return {
      kind: 'checkpoint',
      snapshot: snapshot.success.payload,
      ...metaFields,
    };
  }
  return { kind: 'none', ...metaFields };
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
