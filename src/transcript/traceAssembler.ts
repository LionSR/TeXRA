/**
 * Assembles a {@link TraceDocument} — everything a static trace-viewer needs
 * to replay one finished execution — from the same on-disk data the
 * interactive hosts already read: `ExecutionKVStore` (config/meta),
 * `StreamLogStore` (the round/thinking/tool-call timeline), and
 * `StreamSnapshotStore` (todos/plan/usage sidecars).
 *
 * Host-neutral, following `ChatExportController.buildExportInput`'s
 * discriminated-status pattern so callers can show a precise error instead of
 * a generic failure.
 */
import { getExecutionStore } from '@agent/storage';
import type { ExecutionId } from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';

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
  // A call-scoped read-only store avoids reloading a live host's session or
  // mutating persistence while reading the same transcript files.
  const [streamLogStore, config, meta] = await Promise.all([
    StreamLogStore.openReadOnly(),
    executionStore.readRunRecord(),
    executionStore.readMeta(),
  ]);
  const snapshotStore = new StreamSnapshotStore();
  // The execution→stream mapping is the streamId stamped at registration;
  // a row without one has no persisted stream.
  if (!config) return { status: 'config_missing' };
  const streamId = meta?.streamId;
  if (!streamId) return { status: 'streamLogs_missing' };

  const [, snapshot] = await Promise.all([
    streamLogStore.ensureLoaded(streamId),
    snapshotStore.read(streamId),
  ]);
  const log = streamLogStore.get(streamId);
  if (!log) return { status: 'streamLogs_missing' };

  const terminalStatus = meta?.outcome
    ? runOutcomeToExecutionStatus(meta.outcome)
    : null;

  return {
    status: 'ok',
    trace: {
      executionId,
      streamId,
      config,
      meta,
      entries: log.toJSON(),
      snapshot,
      terminalStatus,
    },
  };
}
