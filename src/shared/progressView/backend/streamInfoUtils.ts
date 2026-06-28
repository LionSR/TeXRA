import {
  AgentCategory,
  type AgentCategoryFilter,
  type RestoredStreamSnapshot,
  STREAM_STATUS,
  type StreamStatus,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { filterNotNull } from '@utils/core';
import { peekWorktreeInfo, resolveWorktreeInfo } from '@utils/git/worktreeInfo';
import { buildStreamTabInfo } from './streamTabInfo';
import { compareByNewestCreationTime } from './streamOrdering';
import type { ProgressViewState } from './state/ProgressViewState';

function ensureWorktreeProbe(workingDirectory: string): void {
  // Fire-and-forget; the resolver owns TTL/in-flight de-duplication. Calling
  // it on each render lets branch/dirty state refresh after the cache expires.
  void resolveWorktreeInfo(workingDirectory).catch(() => {
    /* best-effort chip enrichment */
  });
}

/**
 * Check if a session category matches the given filter.
 * Returns the resolved category (defaulting to Workflow) or null if filtered out.
 */
function matchesFilter(
  category: AgentCategory | undefined,
  filter: AgentCategoryFilter,
): AgentCategory | null {
  const resolved = category ?? AgentCategory.Workflow;

  if (filter === 'all') {
    return resolved;
  }

  const expected =
    filter === 'toolUse' ? AgentCategory.ToolUse : AgentCategory.Workflow;

  return resolved === expected ? resolved : null;
}

/**
 * Build a StreamTabInfo object for a single stream ID.
 * Returns null if the stream doesn't match the filter.
 */
export function buildStreamInfo(
  state: ProgressViewState,
  id: string,
  filter: AgentCategoryFilter,
): StreamTabInfo | null {
  const taskState = state.snapshots.getTaskState(id);
  const hints = state.getStreamHints(id);
  const config = taskState?.agentConfig;

  // Determine category and check filter
  const rawCategory = config?.agentCategory ?? hints.agentCategory;
  const category = matchesFilter(rawCategory, filter);
  if (category === null) return null;

  const creationTimestamp =
    state.streamLogs.getFirstTimestamp(id) ??
    hints.creationTimestamp ??
    Date.now();

  const workingDirectory = config?.workingDirectory ?? undefined;
  let worktreeInfo;
  if (workingDirectory) {
    worktreeInfo = peekWorktreeInfo(workingDirectory);
    ensureWorktreeProbe(workingDirectory);
  }

  return buildStreamTabInfo({
    streamId: id,
    config,
    hints: {
      agent: hints.agent,
      agentCategory: hints.agentCategory,
      inputFile: hints.inputFile,
      isRemote: hints.isRemote,
    },
    creationTimestamp,
    executionId: state.snapshots.getExecutionId(id) ?? hints.executionId,
    parentStreamId:
      state.snapshots.getParentStreamId(id) ?? hints.parentStreamId,
    description: state.snapshots.getDescription(id) ?? hints.description,
    worktreeInfo,
  });
}

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(
  state: ProgressViewState,
  filter: AgentCategoryFilter = 'all',
): StreamTabInfo[] {
  const infos = state.streamLogs
    .keys()
    .map((id) => buildStreamInfo(state, id, filter))
    .filter(filterNotNull);

  return infos.sort(compareByNewestCreationTime);
}

export interface RestoredStreamSnapshotInputs {
  readonly restored?: RestoredStreamSnapshot;
  readonly lastKnownStatus?: StreamStatus;
  readonly now?: () => number;
}

/**
 * Project a progress-view stream into the durable desktop snapshot format.
 * The desktop bridge supplies runtime status and prior restored state; this
 * helper owns the fallback order between live metadata and persisted metadata.
 */
export function buildRestoredStreamSnapshot(
  state: ProgressViewState,
  streamId: StreamTabId,
  inputs: RestoredStreamSnapshotInputs = {},
): RestoredStreamSnapshot {
  const { restored, lastKnownStatus, now } = inputs;
  const taskState = state.snapshots.getTaskState(streamId);
  const info = buildStreamInfo(state, streamId, 'all');
  const persistedAt = now?.() ?? Date.now();

  return {
    streamId,
    label: info?.label ?? restored?.label ?? streamId,
    agent: info?.agent ?? restored?.agent,
    agentCategory:
      info?.agentCategory ?? restored?.agentCategory ?? AgentCategory.Workflow,
    inputFile: info?.inputFile || restored?.inputFile,
    instruction: taskState?.agentConfig.instruction || restored?.instruction,
    lastKnownStatus:
      lastKnownStatus ?? restored?.lastKnownStatus ?? STREAM_STATUS.STOPPED,
    description: info?.description ?? restored?.description,
    executionId: info?.executionId ?? restored?.executionId,
    parentStreamId: info?.parentStreamId ?? restored?.parentStreamId,
    creationTimestamp:
      info?.creationTimestamp ?? restored?.creationTimestamp ?? persistedAt,
    lastTimestamp:
      state.streamLogs.getLastTimestamp(streamId) ?? restored?.lastTimestamp,
    persistedAt,
  };
}
