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
import type { ExecutionId } from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';

import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';
import { resolvePersistedStreamIdForExecution } from './executionStreamResolver';
import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | {
      readonly status:
        'config_missing' | 'streamId_ambiguous' | 'streamLogs_missing';
    };

/**
 * `streamId_ambiguous` means several historical sidecars claim the execution,
 * but persisted evidence does not identify one as canonical. By contrast,
 * `streamLogs_missing` is the expected outcome for executions recorded before
 * the headless-persistence fix (TeXRA#7057), when no replayable transcript was
 * written. Callers should surface both distinctions rather than reporting a
 * generic "not found".
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
    return { status: 'streamId_ambiguous' };
  }
  const streamId = resolved?.streamId ?? fallbackStreamId;
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
