/** Assemble a static trace from run metadata, transcript entries and the root's folded run state. */
import { Effect } from 'effect';
import { readPersistedRunRecord } from '@agent/storage/runLifecycle';
import { getRunRecords } from '@agent/storage/RunKVStore';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { redactDisplayValue } from '@logger/redaction';

import type { RunId } from '@shared/schemas';

import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` means no replayable run timeline is available: the
 * run has no metadata or no authoritative transcript.
 */
export const assembleTrace = Effect.fn('assembleTrace')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<AssembleTraceResult, Error> {
  const [meta, config] = yield* Effect.all(
    [
      getRunRecords(session, runId).readMeta(),
      readPersistedRunRecord(runId, session),
    ],
    { concurrency: 2 },
  );
  if (!config) return { status: 'config_missing' };
  if (!meta) return { status: 'streamLogs_missing' };
  if (!(yield* session.transcripts.hasAuthoritativeRun(runId)))
    return { status: 'streamLogs_missing' };
  const [entries, snapshot] = yield* Effect.all(
    [session.transcripts.readEntries(runId), session.snapshots.read(runId)],
    { concurrency: 2 },
  );
  return {
    status: 'ok',
    trace: redactDisplayValue({
      runId,
      config,
      meta,
      entries,
      snapshot,
    }),
  };
});
