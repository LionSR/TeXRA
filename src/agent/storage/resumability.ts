import { Effect } from 'effect';
import { z } from 'zod';

import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentTrace } from '@agent/trace';
import { createLog } from '@logger/logUtils';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  type FlowSnapshotPayload,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';

import { getRunRecords } from './RunKVStore';

const log = createLog('Resumability');

/**
 * The retired engine's checkpoint, `flow_<id>.json` beside the run's other
 * files. It is never read: it is statted so a run whose only durable state
 * is that file can say so (R10), and renamed `.superseded` before the run's
 * first ledger row so a reverted release cannot resume from a cursor the
 * ledger has moved past. The `.superseded` file stays on disk for the D8
 * sweep.
 */
const RETIRED_CHECKPOINT_PREFIX = 'flow_';
const SUPERSEDED_SUFFIX = '.superseded';

const retiredCheckpointPath = (runId: RunId): string =>
  resolveRunStoragePath(runId, `${RETIRED_CHECKPOINT_PREFIX}${runId}.json`);

/** A retired checkpoint, renamed or not, is internal and never a run output. */
export function isLegacyFlowRecordFile(name: string): boolean {
  return (
    name.startsWith(RETIRED_CHECKPOINT_PREFIX) &&
    (name.endsWith('.json') || name.endsWith(`.json${SUPERSEDED_SUFFIX}`))
  );
}

/**
 * The user-visible fact a listing states for a run whose only durable state
 * is a retired checkpoint (R10).
 */
const RETIRED_CHECKPOINT_NOTICE =
  'This run was recorded before the run ledger and is not resumable under this release.';

/**
 * The rename, never silent: the transcript names the file, its new name, and
 * the fact that this release cannot resume it. Both loops call it before the
 * first ledger append of a fresh run.
 */
export const supersedeLegacyFlowRecord = Effect.fn('supersedeLegacyFlowRecord')(
  function* (
    runId: RunId,
    session: SessionHandle,
    logger: AgentTrace,
  ): Effect.fn.Return<void, Error> {
    const path = retiredCheckpointPath(runId);
    // One session frame for the stat and the rename: the second read would
    // resolve the same workspace roots the first already entered.
    const renamed = yield* Effect.tryPromise({
      try: () =>
        runInSession(session, async () => {
          if (!(await StorageFS.exists(path))) return false;
          await StorageFS.rename(path, `${path}${SUPERSEDED_SUFFIX}`);
          return true;
        }),
      catch: ensureError,
    });
    if (!renamed) return;
    const fileName = `${RETIRED_CHECKPOINT_PREFIX}${runId}.json`;
    logger.warn(
      `A checkpoint from an earlier release (${fileName}) was found for this run. ${RETIRED_CHECKPOINT_NOTICE} It was renamed ${fileName}${SUPERSEDED_SUFFIX}.`,
    );
  },
);

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
 * guessed). A `none` decision carries the R10 notice when the run's only
 * durable state is a retired checkpoint.
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
      readonly notice?: string;
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
  const retired = yield* Effect.tryPromise({
    try: () =>
      runInSession(session, () =>
        StorageFS.exists(retiredCheckpointPath(runId)),
      ),
    catch: ensureError,
  }).pipe(Effect.result);
  if (retired._tag === 'Failure') {
    const error = retired.failure;
    log.debug(
      `Failed to stat the retired checkpoint of ${runId}: ${toErrorMessage(error)}`,
    );
    return {
      kind: 'unreadable',
      fault: 'checkpoint-unreadable',
      cause: `checkpoint could not be read (${toErrorMessage(error)})`,
    };
  }
  return {
    kind: 'none',
    ...metaFields,
    ...(retired.success ? { notice: RETIRED_CHECKPOINT_NOTICE } : {}),
  };
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
