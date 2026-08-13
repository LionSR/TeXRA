import type { SessionState } from '@controllers/session/SessionState';
import type { StreamTabId, StreamTabInfo } from '@shared/schemas';
import { peekWorktreeInfo, resolveWorktreeInfo } from '@utils/git/worktreeInfo';
import { buildStreamTabInfo } from './streamTabInfo';

/** The state a single tab info is built from. */
export type StreamInfoSource = Pick<
  SessionState,
  'getStreamMetadata' | 'streamStatus'
>;

/** The state the full tab list is built from. */
export type StreamInfoListSource = StreamInfoSource &
  Pick<SessionState, 'selectableStreamNames'>;

/** Build a StreamTabInfo object for a single stream ID. */
export function buildStreamInfo(
  state: StreamInfoSource,
  id: string,
  activeStream?: StreamTabId | '',
): StreamTabInfo {
  const metadata = state.getStreamMetadata(id);
  const workingDirectory = metadata.config?.workingDirectory;
  let worktreeInfo;
  if (workingDirectory) {
    worktreeInfo = peekWorktreeInfo(workingDirectory);
    // Probe git only for live streams plus the selected tab: the resolver's
    // LRU holds 32 entries, so probing every historical stream on a metadata
    // rebuild thrashes the cache and spawns git per stream (#9959). Terminal
    // streams render their last-known value from the peek above, or nothing.
    if (id === activeStream || state.streamStatus.isInFlight(id)) {
      // Fire-and-forget; the resolver owns TTL/in-flight de-duplication.
      void resolveWorktreeInfo(workingDirectory).catch(() => {
        /* best-effort chip enrichment */
      });
    }
  }

  return buildStreamTabInfo({
    streamId: id,
    metadata,
    worktreeInfo,
  });
}

/** Build metadata objects for all streams in the given state, newest first. */
export function buildStreamInfos(
  state: StreamInfoListSource,
  activeStream?: StreamTabId | '',
): StreamTabInfo[] {
  // selectableStreamNames() already returns newest-first, so the mapped
  // tab infos inherit that order without re-sorting.
  return state
    .selectableStreamNames()
    .map((id) => buildStreamInfo(state, id, activeStream));
}
