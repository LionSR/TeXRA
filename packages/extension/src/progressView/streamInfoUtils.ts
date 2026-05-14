import {
  buildStreamTabInfo,
  peekWorktreeInfo,
  resolveWorktreeInfo,
} from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentCategoryFilter, StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from './streamOrdering';
import type { ProgressViewState } from './state/ProgressViewState';

/** Working directories whose worktree probe has been kicked off. Prevents
 *  re-triggering an async probe on every render while the cache is empty. */
const probedDirs = new Set<string>();

function ensureWorktreeProbe(workingDirectory: string): void {
  if (probedDirs.has(workingDirectory)) return;
  probedDirs.add(workingDirectory);
  // Fire-and-forget; the cache populates for the next render. Failures fall
  // back to the minimal `{ workingDirectory }` chip and are ignored here.
  void resolveWorktreeInfo(workingDirectory).catch(() => {
    probedDirs.delete(workingDirectory);
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
  const taskState = state.meta.getTaskState(id);
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
      agentCategory: hints.agentCategory,
      isRemote: hints.isRemote,
    },
    creationTimestamp,
    executionId: state.meta.getExecutionId(id),
    parentStreamId: state.meta.getParentStreamId(id),
    description: state.meta.getDescription(id),
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
    .filter((info): info is StreamTabInfo => info !== null);

  return infos.sort(compareByNewestCreationTime);
}
