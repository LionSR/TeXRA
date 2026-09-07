/** Assemble a static trace from execution metadata, transcript entries and the root's folded stream state. */
import { Effect } from 'effect';

import { getExecutionStore } from '@agent/storage';
import type { ExecutionId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

import { resolveStreamForExecution } from './completedRunArchive';
import { StreamLogStore } from './StreamLogStore';
import type { StreamSnapshotStore } from './StreamSnapshotStore';
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
  snapshots: Pick<StreamSnapshotStore, 'read'>,
): Effect.fn.Return<AssembleTraceResult, Error> {
  const executionStore = getExecutionStore(executionId);
  const [resolution, config] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        resolveStreamForExecution(executionId),
        executionStore.readRunRecord(),
      ]),
    catch: ensureError,
  });
  if (!config) return { status: 'config_missing' };
  if (!resolution) return { status: 'streamLogs_missing' };
  const { streamId, meta } = resolution;
  const streamLogStore = yield* Effect.tryPromise({
    try: () => StreamLogStore.openReadOnlyForStream(streamId),
    catch: ensureError,
  });
  if (!streamLogStore.has(streamId)) return { status: 'streamLogs_missing' };
  const [entries, snapshot] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () => streamLogStore.readEntries(streamId),
        catch: ensureError,
      }),
      snapshots.read(streamId),
    ],
    { concurrency: 2 },
  );
  return {
    status: 'ok',
    trace: { executionId, streamId, config, meta, entries, snapshot },
  };
});
