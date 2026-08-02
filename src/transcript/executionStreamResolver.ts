import pMap from 'p-map';

import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { writeLegacyExecutionStreamId } from '@agent/storage/executionLifecycle';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StreamLogStore } from './StreamLogStore';

type PersistedStreamIdResolutionSource =
  'executionMeta' | 'streamDataMeta' | 'streamDataSuffix' | 'streamLogsSuffix';

export interface PersistedStreamIdResolution {
  readonly streamId: StreamTabId;
  readonly source: PersistedStreamIdResolutionSource;
  /** Other persisted candidates to try when a historical primary is empty. */
  readonly fallbackStreamIds?: readonly StreamTabId[];
  /** Exact execution matches with no persisted parent, for archive merging. */
  readonly associatedRootStreamIds?: readonly StreamTabId[];
}

export interface PersistedStreamIdResolverOptions {
  readonly snapshotStore?: StreamSnapshotStore;
  readonly streamLogStore?: Pick<StreamLogStore, 'keys' | 'has'>;
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
  /** Exact execution matches that are not recorded as child streams. */
  readonly rootMetaMatched: StreamTabId[];
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
      association: await snapshotStore.readPersistedStreamAssociation(streamId),
    }),
    { concurrency: META_SCAN_CONCURRENCY },
  );
  return {
    persistedStreams,
    metaMatched: scanned
      .filter((candidate) => candidate.association.executionId === executionId)
      .map((candidate) => candidate.streamId),
    rootMetaMatched: scanned
      .filter(
        (candidate) =>
          candidate.association.executionId === executionId &&
          candidate.association.parentStreamId === undefined,
      )
      .map((candidate) => candidate.streamId)
      .toSorted(),
  };
}

/** Streams whose id carries the `#executionId` suffix, in the given order. */
function findExecutionSuffixMatches(
  streams: readonly StreamTabId[],
  executionId: ExecutionId,
): StreamTabId[] {
  const suffix = `#${executionId}`;
  return streams.filter((id) => id.endsWith(suffix));
}

/** Choose the data-bearing primary for an ambiguous historical record. */
async function pickBestLegacyMetaMatch(
  candidates: readonly StreamTabId[],
  snapshotStore: StreamSnapshotStore,
  streamLogStore: Pick<StreamLogStore, 'has'> | undefined,
): Promise<StreamTabId> {
  if (candidates.length === 1) return candidates[0];

  const withData = await pMap(
    candidates,
    async (streamId) => {
      const hasLog = streamLogStore?.has(streamId) ?? false;
      return {
        streamId,
        hasLog,
        hasWorkPlan:
          hasLog || (await snapshotStore.hasPersistedWorkPlan(streamId)),
      };
    },
    { concurrency: META_SCAN_CONCURRENCY },
  );
  return (
    withData.find((entry) => entry.hasLog)?.streamId ??
    withData.find((entry) => entry.hasWorkPlan)?.streamId ??
    candidates[0]
  );
}

function orderedFallbacks(
  primary: StreamTabId,
  candidates: readonly StreamTabId[],
): StreamTabId[] {
  const seen = new Set<StreamTabId>([primary]);
  return candidates.filter((streamId) => {
    if (seen.has(streamId)) return false;
    seen.add(streamId);
    return true;
  });
}

/**
 * Find alternative persisted streams for the rare case where a historical
 * primary reconstructs no conversation. Current executions do not need this
 * scan unless their registered stream is unexpectedly empty.
 */
export async function findPersistedStreamFallbacksForExecution(
  executionId: ExecutionId,
  primary: StreamTabId,
  options: PersistedStreamIdResolverOptions = {},
): Promise<StreamTabId[]> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const { persistedStreams, metaMatched } =
    await scanPersistedStreamsForExecution(executionId, snapshotStore);
  const suffixMatched = findExecutionSuffixMatches(
    [...persistedStreams, ...(options.streamLogStore?.keys() ?? [])],
    executionId,
  );
  return orderedFallbacks(primary, [...metaMatched, ...suffixMatched]);
}

/**
 * Resolve an execution id to the stream id used by transcript sidecars.
 *
 * New executions carry this mapping in their own metadata from registration.
 * The ranked sidecar scan and suffix checks are compatibility fallbacks for
 * records created before that field existed; current records never enter that
 * branch. A unique confirmed legacy match is written through once so later
 * reads use the same constant-time metadata path as current executions.
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
  const { persistedStreams, metaMatched, rootMetaMatched } =
    await scanPersistedStreamsForExecution(executionId, snapshotStore);

  if (metaMatched.length > 0) {
    const streamId = await pickBestLegacyMetaMatch(
      metaMatched,
      snapshotStore,
      options.streamLogStore,
    );
    if (metaMatched.length === 1) {
      await writeLegacyExecutionStreamId(executionId, streamId);
    }
    const suffixMatched = findExecutionSuffixMatches(
      [...persistedStreams, ...(options.streamLogStore?.keys() ?? [])],
      executionId,
    );
    const fallbackStreamIds = orderedFallbacks(streamId, [
      ...metaMatched,
      ...suffixMatched,
    ]);
    return {
      streamId,
      source: 'streamDataMeta',
      ...(fallbackStreamIds.length > 0 ? { fallbackStreamIds } : {}),
      ...(metaMatched.length > 1 && rootMetaMatched.length > 0
        ? { associatedRootStreamIds: rootMetaMatched }
        : {}),
    };
  }

  const matchedSidecars = findExecutionSuffixMatches(
    persistedStreams,
    executionId,
  );
  const matchedSidecar = matchedSidecars[0];
  if (matchedSidecar) {
    const fallbackStreamIds = orderedFallbacks(matchedSidecar, matchedSidecars);
    return {
      streamId: matchedSidecar,
      source: 'streamDataSuffix',
      ...(fallbackStreamIds.length > 0 ? { fallbackStreamIds } : {}),
    };
  }

  const matchedLogs = options.streamLogStore
    ? findExecutionSuffixMatches(options.streamLogStore.keys(), executionId)
    : [];
  const matchedLog = matchedLogs[0];
  if (matchedLog) {
    const fallbackStreamIds = orderedFallbacks(matchedLog, matchedLogs);
    return {
      streamId: matchedLog,
      source: 'streamLogsSuffix',
      ...(fallbackStreamIds.length > 0 ? { fallbackStreamIds } : {}),
    };
  }

  return null;
}
