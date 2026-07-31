import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentCategoryFilter, StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { filterNotNull } from '@utils/core';
import { peekWorktreeInfo, resolveWorktreeInfo } from '@utils/git/worktreeInfo';
import { buildStreamTabInfo } from './streamTabInfo';
import type { ProgressViewState } from './state/ProgressViewState';

/**
 * Whether a stream is visible under a category filter.
 *
 * Pure metadata comparison: unlike {@link buildStreamInfo} it does no worktree
 * resolution, so membership checks don't spawn git processes for an answer
 * that only depends on the stream's category.
 */
export function streamMatchesCategoryFilter(
  state: Pick<ProgressViewState, 'getStreamMetadata'>,
  id: string,
  filter: AgentCategoryFilter,
): boolean {
  if (filter === 'all') return true;
  // A stream is Workflow until its run config resolves its real category.
  const category =
    state.getStreamMetadata(id).agentCategory ?? AgentCategory.Workflow;
  return category === filter;
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
  if (!streamMatchesCategoryFilter(state, id, filter)) return null;

  const metadata = state.getStreamMetadata(id);
  const workingDirectory = metadata.run?.workingDirectory;
  let worktreeInfo;
  if (workingDirectory) {
    worktreeInfo = peekWorktreeInfo(workingDirectory);
    // Fire-and-forget; the resolver owns TTL/in-flight de-duplication. Calling
    // it on each render lets branch/dirty state refresh after the cache expires.
    void resolveWorktreeInfo(workingDirectory).catch(() => {
      /* best-effort chip enrichment */
    });
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
