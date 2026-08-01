import pMap from 'p-map';

import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StreamLogStore } from './StreamLogStore';

type PersistedStreamIdResolutionSource =
  'executionMeta' | 'streamDataMeta' | 'streamDataSuffix' | 'streamLogsSuffix';

export interface PersistedStreamIdResolution {
  readonly streamId: StreamTabId;
  readonly source: PersistedStreamIdResolutionSource;
}

export interface PersistedStreamIdResolverOptions {
  readonly snapshotStore?: StreamSnapshotStore;
  readonly streamLogStore?: Pick<StreamLogStore, 'keys'>;
}

/**
 * Bounded fan-out for the per-execution meta scan. This resolver now runs on
 * hot paths (every completed `/executions/{id}` summary, every
 * `assembleTrace()` call) instead of the rare bulk-admin sweeps it was
 * originally built for, so an unbounded `Promise.all` over every persisted
 * stream risks file-descriptor pressure in a workspace with a large history.
 */
const META_SCAN_CONCURRENCY = 8;

interface ExecutionStreamScan {
  /** Every stream with sidecars under `streamData/`, in enumeration order. */
  readonly persistedStreams: StreamTabId[];
  /** Persisted streams whose sidecar `meta.json` claims this execution. */
  readonly metaMatched: StreamTabId[];
}

/**
 * Compatibility scan for executions registered before their stream identity
 * was stored directly: list every `streamData/` stream once, read each one's
 * `meta.json` executionId, and report which of them claim `executionId`.
 */
async function scanPersistedStreamsForExecution(
  executionId: ExecutionId,
  snapshotStore: StreamSnapshotStore,
): Promise<ExecutionStreamScan> {
  const persistedStreams = await snapshotStore.listPersistedStreams();
  const scanned = await pMap(
    persistedStreams,
    async (streamId) => ({
      streamId,
      executionId: await snapshotStore.readPersistedExecutionId(streamId),
    }),
    { concurrency: META_SCAN_CONCURRENCY },
  );
  return {
    persistedStreams,
    metaMatched: scanned
      .filter((candidate) => candidate.executionId === executionId)
      .map((candidate) => candidate.streamId),
  };
}

/** Streams whose id carries the `#executionId` suffix, in the given order. */
export function findExecutionSuffixMatches(
  streams: readonly StreamTabId[],
  executionId: ExecutionId,
): StreamTabId[] {
  const suffix = `#${executionId}`;
  return streams.filter((id) => id.endsWith(suffix));
}

/**
 * Resolve an execution id to the stream id used by transcript sidecars.
 *
 * New executions carry this mapping in their own metadata from registration.
 * The sidecar scan and suffix checks are compatibility fallbacks for records
 * created before that field existed. Enumeration order settles ambiguous old
 * records; current records never enter that branch.
 *
 * `null` means no persisted stream carries this execution. Callers that have
 * a derivable stream id own that substitution.
 */
export async function resolvePersistedStreamIdForExecution(
  executionId: ExecutionId,
  options: PersistedStreamIdResolverOptions = {},
): Promise<PersistedStreamIdResolution | null> {
  const registeredStreamId = (await getExecutionStore(executionId).readMeta())
    ?.streamId;
  if (registeredStreamId) {
    return { streamId: registeredStreamId, source: 'executionMeta' };
  }

  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const { persistedStreams, metaMatched } =
    await scanPersistedStreamsForExecution(executionId, snapshotStore);

  if (metaMatched.length > 0) {
    return { streamId: metaMatched[0], source: 'streamDataMeta' };
  }

  const matchedSidecar = findExecutionSuffixMatches(
    persistedStreams,
    executionId,
  )[0];
  if (matchedSidecar) {
    return { streamId: matchedSidecar, source: 'streamDataSuffix' };
  }

  const matchedLog = options.streamLogStore
    ? findExecutionSuffixMatches(options.streamLogStore.keys(), executionId)[0]
    : undefined;
  if (matchedLog) {
    return { streamId: matchedLog, source: 'streamLogsSuffix' };
  }

  return null;
}
