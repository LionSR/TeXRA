import type { ExecutionId, StreamTabId } from '@shared/schemas';

import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StreamLogStore } from './StreamLogStore';

export type PersistedStreamIdResolutionSource =
  'streamDataMeta' | 'streamDataSuffix' | 'streamLogsSuffix' | 'fallback';

export interface PersistedStreamIdResolution {
  readonly streamId: StreamTabId;
  readonly source: PersistedStreamIdResolutionSource;
}

export interface PersistedStreamIdResolverOptions {
  readonly snapshotStore?: StreamSnapshotStore;
  readonly streamLogStore?: Pick<StreamLogStore, 'keys'>;
  readonly fallbackStreamId?: StreamTabId;
}

function findSuffixMatch(
  streams: readonly StreamTabId[],
  executionId: ExecutionId,
): StreamTabId | undefined {
  const suffix = `#${executionId}`;
  return streams.find((id) => id.endsWith(suffix));
}

/**
 * Resolve an execution id to the stream id used by transcript sidecars.
 *
 * The sidecar metadata is canonical. The suffix checks preserve compatibility
 * with older records and child-stream prefixes that cannot be derived from the
 * top-level agent/model pair.
 */
export async function resolvePersistedStreamIdForExecution(
  executionId: ExecutionId,
  options: PersistedStreamIdResolverOptions = {},
): Promise<PersistedStreamIdResolution | null> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const persistedStreams = await snapshotStore.listPersistedStreams();

  const matchedByMeta = (
    await Promise.all(
      persistedStreams.map(async (streamId) => ({
        streamId,
        executionId: await snapshotStore.readPersistedExecutionId(streamId),
      })),
    )
  ).find((candidate) => candidate.executionId === executionId);
  if (matchedByMeta) {
    return { streamId: matchedByMeta.streamId, source: 'streamDataMeta' };
  }

  const matchedSidecar = findSuffixMatch(persistedStreams, executionId);
  if (matchedSidecar) {
    return { streamId: matchedSidecar, source: 'streamDataSuffix' };
  }

  const matchedLog = options.streamLogStore
    ? findSuffixMatch(options.streamLogStore.keys(), executionId)
    : undefined;
  if (matchedLog) {
    return { streamId: matchedLog, source: 'streamLogsSuffix' };
  }

  return options.fallbackStreamId
    ? { streamId: options.fallbackStreamId, source: 'fallback' }
    : null;
}
