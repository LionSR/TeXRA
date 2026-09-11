import { Effect } from 'effect';
import { z } from 'zod';

import {
  PersistedFlowRecordEnvelopeSchema,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import { type RunId, type RunOutcome } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { getRunRecords, getRunStore } from './RunKVStore';

const log = createLog('Resumability');

const ResumableSharedSchema = z.record(z.string(), z.unknown());
const ResumableFlowRecordSchema = PersistedFlowRecordEnvelopeSchema.refine(
  (record) => ResumableSharedSchema.safeParse(record.shared).success,
  {
    message: 'Resumable flow shared state must be an object',
    path: ['shared'],
  },
).refine((record) => record.cursor.nextNodeId !== null, {
  // A run that ended leaves a spent cursor; only a rewound record (cancelled
  // or failed exits rewind to the start node) is a checkpoint to continue.
  message: 'A spent cursor is not a resumable checkpoint',
  path: ['cursor', 'nextNodeId'],
});

/**
 * Which durable fact was unreadable. Only `checkpoint-malformed` positively
 * names the checkpoint's own content, so it is the one fault a caller may
 * word as "this run's saved state cannot be resumed"; the rest are read
 * failures that say nothing about the checkpoint and stay operational
 * errors. Callers discriminate on this, never on {@link
 * ResumabilityDecision.cause}, which is display text.
 */
export type ResumabilityFault =
  | 'metadata-unreadable'
  | 'metadata-malformed'
  | 'checkpoint-unreadable'
  | 'checkpoint-malformed';

/**
 * What the durable run facts alone say about continuing a run:
 * a valid checkpoint exists, nothing is left to resume, or the storage
 * itself could not be read (reported with its cause, never guessed).
 */
export type ResumabilityDecision =
  | {
      readonly kind: 'checkpoint';
      readonly flowRecord: FlowRecord;
      readonly outcome?: RunOutcome;
    }
  | { readonly kind: 'none'; readonly outcome?: RunOutcome }
  | {
      readonly kind: 'unreadable';
      readonly cause: string;
      readonly fault: ResumabilityFault;
    };

/**
 * Single storage-owned resumability decision.
 *
 * A checkpoint means exactly one thing: a valid flow record exists. The
 * terminal outcome is read and reported on the decision for display, but it
 * never blocks: a checkpoint is deleted only by the user or by a genuinely
 * completed run, so a failed run that still has one is offered as "retry
 * from the last checkpoint". Ownership is not decided here; `classifyRun`
 * (`@agent/runtime/runClassification`) combines this decision with the
 * run lease.
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
  const checkpoint = yield* Effect.tryPromise({
    try: () =>
      runInSession(session, () => getRunStore(runId).read(flowKey(runId))),
    catch: ensureError,
  }).pipe(Effect.result);
  if (checkpoint._tag === 'Failure') {
    const error = checkpoint.failure;
    log.debug(
      `Failed to read flow record for ${runId}: ${toErrorMessage(error)}`,
    );
    return {
      kind: 'unreadable',
      fault: 'checkpoint-unreadable',
      cause: `checkpoint could not be read (${toErrorMessage(error)})`,
    };
  }
  if (checkpoint.success === undefined) return { kind: 'none', ...metaFields };
  const flowResult = ResumableFlowRecordSchema.safeParse(checkpoint.success);
  if (!flowResult.success) {
    return {
      kind: 'unreadable',
      fault: 'checkpoint-malformed',
      cause: 'checkpoint is malformed',
    };
  }
  return { kind: 'checkpoint', flowRecord: flowResult.data, ...metaFields };
});

/**
 * Whether a run's checkpoint file is on disk — one `stat`, never a parse.
 *
 * A probe that fails answers "no checkpoint" and says so at `warn` with the
 * run it belongs to: a listing must still show the row it can read from
 * meta and record rather than dropping the run out of history, and the open
 * path re-reads the file and refuses there if it disagrees.
 */
export const checkpointExists = Effect.fn('checkpointExists')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise({
    try: () =>
      runInSession(session, () => getRunStore(runId).exists(flowKey(runId))),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn(
          `Could not stat the checkpoint of ${runId}: ${toErrorMessage(error)}`,
          { data: error },
        );
        return false;
      }),
    ),
  );
});
