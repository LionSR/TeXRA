/** Assemble a static trace from execution metadata, transcript entries and the root's folded stream state. */
import { Effect } from 'effect';
import { getRunRecords } from '@agent/storage/ExecutionKVStore';
import { readRunLaunchRecord } from '@agent/storage/executionLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { redactDisplayValue } from '@logger/redaction';

import type { RunId } from '@shared/schemas';

import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` means no replayable execution-root timeline is
 * available: the run predates transcript persistence, or it has no
 * execution metadata.
 */
export const assembleTrace = Effect.fn('assembleTrace')(function* (
  executionId: RunId,
  session: SessionHandle,
): Effect.fn.Return<AssembleTraceResult, Error> {
  const [meta, config] = yield* Effect.all(
    [
      getRunRecords(session, executionId).readMeta(),
      readRunLaunchRecord(executionId, session),
    ],
    { concurrency: 2 },
  );
  if (!config) return { status: 'config_missing' };
  if (!meta) return { status: 'streamLogs_missing' };
  if (!(yield* session.transcripts.hasAuthoritativeStream(executionId)))
    return { status: 'streamLogs_missing' };
  const [entries, snapshot] = yield* Effect.all(
    [
      session.transcripts.readEntries(executionId),
      session.snapshots.read(executionId),
    ],
    { concurrency: 2 },
  );
  return {
    status: 'ok',
    trace: redactDisplayValue({
      executionId,
      streamId: executionId,
      config,
      meta,
      entries,
      snapshot,
    }),
  };
});
