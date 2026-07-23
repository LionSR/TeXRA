import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentCategoryFilter, StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { filterNotNull } from '@utils/core';
import { peekWorktreeInfo, resolveWorktreeInfo } from '@utils/git/worktreeInfo';
import { buildStreamTabInfo } from './streamTabInfo';
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
  const metadata = state.getStreamMetadata(id);

  // Determine category and check filter
  const category = matchesFilter(metadata.agentCategory, filter);
  if (category === null) return null;

  const workingDirectory = metadata.run?.workingDirectory;
  let worktreeInfo;
  if (workingDirectory) {
    worktreeInfo = peekWorktreeInfo(workingDirectory);
    ensureWorktreeProbe(workingDirectory);
  }

  return buildStreamTabInfo({
    streamId: id,
    metadata,
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
