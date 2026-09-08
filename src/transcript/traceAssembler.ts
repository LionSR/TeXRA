/** Assemble a static trace from execution metadata, transcript entries and the root's folded stream state. */
import { Effect } from 'effect';
import {
  readExecutionRunRecord,
  resolveStreamForExecution,
} from '@agent/storage/executionLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

import type { ExecutionId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` means no replayable execution-root timeline is
 * available: the run predates transcript persistence, or its metadata
 * carries no stamped stream id.
 */
export const assembleTrace = Effect.fn('assembleTrace')(function* (
  executionId: ExecutionId,
  session: Pick<SessionHandle, 'roots' | 'snapshots' | 'transcripts'>,
): Effect.fn.Return<AssembleTraceResult, Error> {
  const [resolution, config] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        resolveStreamForExecution(executionId, session.roots),
        readExecutionRunRecord(executionId, session.roots),
      ]),
    catch: ensureError,
  });
  if (!config) return { status: 'config_missing' };
  if (!resolution) return { status: 'streamLogs_missing' };
  const { streamId, meta } = resolution;
  if (!(yield* session.transcripts.hasAuthoritativeStream(streamId)))
    return { status: 'streamLogs_missing' };
  const [entries, snapshot] = yield* Effect.all(
    [
      session.transcripts.readEntries(streamId),
      session.snapshots.read(streamId),
    ],
    { concurrency: 2 },
  );
  return {
    status: 'ok',
    trace: { executionId, streamId, config, meta, entries, snapshot },
  };
});
