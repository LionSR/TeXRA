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
import { getExecutionStore, type ExecutionMeta } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { runOutcomeToExecutionStatus } from '@common/constants/streamStatus';
import type {
  ExecutionId,
  ExecutionStatus,
  StreamLogEntry,
  StreamSnapshot,
  StreamTabId,
} from '@shared/schemas';

import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';

export interface TraceDocument {
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
  readonly config: AgentConfig;
  readonly meta: ExecutionMeta | null;
  readonly entries: StreamLogEntry[];
  readonly snapshot: StreamSnapshot;
  /** `null` when the execution predates outcome tracking or never reached a terminal state. */
  readonly terminalStatus: ExecutionStatus | null;
}

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` is the expected outcome for any execution recorded
 * before the headless-persistence fix (TeXRA#7057) — headless runs before
 * that fix never wrote a `streamLogs` file at all, so there is nothing here
 * to replay faithfully. Callers should surface that distinction rather than
 * a generic "not found".
 */
export async function assembleTrace(
  executionId: ExecutionId,
): Promise<AssembleTraceResult> {
  const executionStore = getExecutionStore(executionId);
  // A fresh instance, not the shared getDefaultStreamLogStore() singleton:
  // .load() clears all of a store's in-memory state, which would wipe out a
  // live host's in-flight session if this ran against the shared instance.
  // Reads the same on-disk files regardless — StreamSnapshotStore below
  // already follows this same call-scoped-instance pattern.
  const streamLogStore = new StreamLogStore();
  const [config, meta] = await Promise.all([
    executionStore.readConfig(),
    executionStore.readMeta(),
    streamLogStore.load(),
  ]);
  if (!config) return { status: 'config_missing' };

  // Resolve the persisted streamId by executionId suffix rather than
  // deriving it: a top-level run uses `agent@model#executionId`
  // (getStreamTabId), but a background child stream (bash/codex/claude
  // subagent, see @tools/childStream.createChildStream) uses a
  // tool-specific `${streamPrefix}#executionId` instead. Every streamId
  // ends in `#executionId` regardless of prefix scheme, and executionId is
  // unique, so searching by suffix resolves both without this module having
  // to know every child-stream prefix convention. Falls back to the derived
  // top-level id if load() found nothing at all under this executionId.
  const suffix = `#${executionId}`;
  const streamId =
    streamLogStore.keys().find((id) => id.endsWith(suffix)) ??
    getStreamTabId(config.agent, config.model, { executionId });

  const [, snapshot] = await Promise.all([
    streamLogStore.ensureLoaded(streamId),
    new StreamSnapshotStore().read(streamId),
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
