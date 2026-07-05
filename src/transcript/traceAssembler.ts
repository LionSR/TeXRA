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

import { getDefaultStreamLogStore } from './StreamLogStore';
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
  const [config, meta] = await Promise.all([
    executionStore.readConfig(),
    executionStore.readMeta(),
  ]);
  if (!config) return { status: 'config_missing' };

  // `streamId` is a composite of agent/model/executionId, not the executionId
  // itself — see @agent/runtime/streamTab.getStreamTabId.
  const streamId = getStreamTabId(config.agent, config.model, {
    executionId,
  });

  const streamLogStore = getDefaultStreamLogStore();
  // Assumes a one-shot process (e.g. a CLI export command): `.load()` resets
  // the store's in-memory state, so this must not run inside a long-lived
  // host with an active session sharing the same store instance.
  try {
    await streamLogStore.load();
  } catch {
    // Persistence stays unavailable; ensureLoaded/get below will just find
    // nothing, which the streamLogs_missing branch below already handles.
  }
  await streamLogStore.ensureLoaded(streamId);
  const log = streamLogStore.get(streamId);
  if (!log) return { status: 'streamLogs_missing' };

  const snapshot = await new StreamSnapshotStore().read(streamId);
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
