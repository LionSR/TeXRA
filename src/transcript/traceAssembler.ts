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
import { getStreamTabId } from '@agent/runtime/streamTab';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';

import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';
import { resolvePersistedStreamIdForExecution } from './executionStreamResolver';
import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' }
  | {
      readonly status: 'streamId_ambiguous';
      readonly candidateStreamIds: readonly StreamTabId[];
    };

/**
 * `streamId_ambiguous` means several unproven archive roots claim the
 * execution, but persisted evidence does not identify one as canonical. By
 * contrast, `streamLogs_missing` means no replayable execution-root timeline
 * is available, either because the run predates transcript persistence or
 * because its only exact associations are proven children. Callers should
 * surface both distinctions rather than reporting a generic "not found".
 */
export async function assembleTrace(
  executionId: ExecutionId,
): Promise<AssembleTraceResult> {
  const executionStore = getExecutionStore(executionId);
  // A call-scoped read-only store avoids reloading a live host's session or
  // mutating persistence while reading the same transcript files.
  const [streamLogStore, config, meta] = await Promise.all([
    StreamLogStore.openReadOnly(),
    executionStore.readConfig(),
    executionStore.readMeta(),
  ]);
  if (!config) return { status: 'config_missing' };

  const fallbackStreamId = getStreamTabId(config.agent, config.model, {
    executionId,
  });
  // One call-scoped snapshot store serves both the resolver's sidecar scan and
  // the snapshot read, so the two share its per-stream KV handles.
  const snapshotStore = new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
    streamLogStore,
  });
  if (resolved && !resolved.streamId) {
    const candidateStreamIds = resolved.exactExecutionCandidateStreamIds ?? [];
    return candidateStreamIds.length > 0
      ? { status: 'streamId_ambiguous', candidateStreamIds }
      : { status: 'streamLogs_missing' };
  }
  const streamId = resolved?.streamId ?? fallbackStreamId;

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
