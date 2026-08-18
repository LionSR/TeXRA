/**
 * Assembles a {@link TraceDocument} — everything a static trace-viewer needs
 * to replay one finished execution — from the same on-disk data the
 * interactive hosts already read: `ExecutionKVStore` (config/meta),
 * `StreamLogStore` (the round/thinking/tool-call timeline), and
 * `StreamSnapshotStore` (todos/plan/usage sidecars).
 *
 * Host-neutral, following {@link loadChatExportInput}'s discriminated-status
 * pattern so callers can show a precise error instead of a generic failure.
 */
import { getExecutionStore } from '@agent/storage';
import type { ExecutionId } from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';

import { resolveStreamForExecution } from './completedRunArchive';
import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` means no replayable execution-root timeline is
 * available: the run predates transcript persistence, or its metadata
 * carries no stamped stream id.
 */
export async function assembleTrace(
  executionId: ExecutionId,
): Promise<AssembleTraceResult> {
  const executionStore = getExecutionStore(executionId);
  const [resolution, config] = await Promise.all([
    resolveStreamForExecution(executionId),
    executionStore.readRunRecord(),
  ]);
  const snapshotStore = new StreamSnapshotStore();
  if (!config) return { status: 'config_missing' };
  if ('reason' in resolution) return { status: 'streamLogs_missing' };
  const { streamId, meta } = resolution;

  // A call-scoped read-only store seeded with just this stream avoids
  // reloading a live host's session, scanning the whole streamLogs
  // directory, or mutating persistence while reading the transcript files.
  const streamLogStore = await StreamLogStore.openReadOnlyForStream(streamId);
  if (!streamLogStore.has(streamId)) return { status: 'streamLogs_missing' };
  const [entries, snapshot] = await Promise.all([
    streamLogStore.readEntries(streamId),
    snapshotStore.read(streamId),
  ]);

  const terminalStatus = meta.outcome
    ? runOutcomeToExecutionStatus(meta.outcome)
    : null;

  return {
    status: 'ok',
    trace: {
      executionId,
      streamId,
      config,
      meta,
      entries,
      snapshot,
      terminalStatus,
    },
  };
}
