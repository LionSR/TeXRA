import type { StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { peekWorktreeInfo, resolveWorktreeInfo } from '@utils/git/worktreeInfo';
import { buildStreamTabInfo } from './streamTabInfo';
import type { ProgressViewState } from './ProgressViewState';

/** The state a single tab info is built from. */
export type StreamInfoSource = Pick<ProgressViewState, 'getStreamMetadata'>;

/** The state the full tab list is built from. */
export type StreamInfoListSource = StreamInfoSource &
  Pick<ProgressViewState, 'selectableStreamNames'>;

/** Build a StreamTabInfo object for a single stream ID. */
export function buildStreamInfo(
  state: StreamInfoSource,
  id: string,
): StreamTabInfo {
  const metadata = state.getStreamMetadata(id);
  const workingDirectory = metadata.config?.workingDirectory;
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

/** Build metadata objects for all streams in the given state, newest first. */
export function buildStreamInfos(state: StreamInfoListSource): StreamTabInfo[] {
  return state
    .selectableStreamNames()
    .map((id) => buildStreamInfo(state, id))
    .sort(compareByNewestCreationTime);
}
