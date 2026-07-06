import pMap from 'p-map';

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
  readonly streamLogStore?: Pick<StreamLogStore, 'keys' | 'has'>;
  readonly fallbackStreamId?: StreamTabId;
}

/**
 * Bounded fan-out for the per-execution meta scan. This resolver now runs on
 * hot paths (every completed `/executions/{id}` summary, every
 * `assembleTrace()` call) instead of the rare bulk-admin sweeps it was
 * originally built for, so an unbounded `Promise.all` over every persisted
 * stream risks file-descriptor pressure in a workspace with a large history.
 */
const META_SCAN_CONCURRENCY = 8;

interface MetaMatchCandidate {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId | undefined;
}

function findSuffixMatch(
  streams: readonly StreamTabId[],
  executionId: ExecutionId,
): StreamTabId | undefined {
  const suffix = `#${executionId}`;
  return streams.find((id) => id.endsWith(suffix));
}

/**
 * Whether a meta-matched candidate actually holds durable data for this
 * execution, as opposed to a bare `meta.json` record. Checked cheaply: an
 * already-loaded `StreamLogStore.has()` lookup is O(1) in-memory, and
 * `hasPersistedWorkPlan()` is a single stat, so this never re-reads the full
 * per-stream sidecar set.
 */
async function hasRealPersistedData(
  snapshotStore: StreamSnapshotStore,
  streamId: StreamTabId,
  streamLogStore: Pick<StreamLogStore, 'keys' | 'has'> | undefined,
): Promise<boolean> {
  if (streamLogStore?.has(streamId)) return true;
  return snapshotStore.hasPersistedWorkPlan(streamId);
}

/**
 * Disambiguate multiple persisted streams whose sidecar `meta.json` all
 * reference the same `executionId` (e.g. a parent orchestrator tab and a
 * `bash@tool#executionId` child stream). Prefers the first candidate that
 * actually has `streamLogs`/`workPlan.json` data; a bare metadata match is a
 * last resort so the resolver still returns *something* rather than nothing.
 */
async function pickBestMetaMatch(
  candidates: readonly MetaMatchCandidate[],
  snapshotStore: StreamSnapshotStore,
  streamLogStore: Pick<StreamLogStore, 'keys' | 'has'> | undefined,
): Promise<StreamTabId> {
  if (candidates.length === 1) return candidates[0].streamId;

  const withData = await pMap(
    candidates,
    async (candidate) => ({
      candidate,
      hasData: await hasRealPersistedData(
        snapshotStore,
        candidate.streamId,
        streamLogStore,
      ),
    }),
    { concurrency: META_SCAN_CONCURRENCY },
  );
  return (
    withData.find((entry) => entry.hasData)?.candidate.streamId ??
    candidates[0].streamId
  );
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

  const metaCandidates = (
    await pMap(
      persistedStreams,
      async (streamId): Promise<MetaMatchCandidate> => ({
        streamId,
        executionId: await snapshotStore.readPersistedExecutionId(streamId),
      }),
      { concurrency: META_SCAN_CONCURRENCY },
    )
  ).filter((candidate) => candidate.executionId === executionId);

  if (metaCandidates.length > 0) {
    const streamId = await pickBestMetaMatch(
      metaCandidates,
      snapshotStore,
      options.streamLogStore,
    );
    return { streamId, source: 'streamDataMeta' };
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
