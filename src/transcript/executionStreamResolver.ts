import pMap from 'p-map';

import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { writeExecutionStreamId } from '@agent/storage/executionLifecycle';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StreamLogStore } from './StreamLogStore';

export type PersistedStreamIdResolutionSource =
  | 'executionMeta'
  | 'streamDataMeta'
  | 'streamDataSuffix'
  | 'streamLogsSuffix'
  | 'fallback';

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

interface MetaMatchDataPresence {
  readonly hasLog: boolean;
  readonly hasWorkPlan: boolean;
}

/**
 * Whether a meta-matched candidate actually holds durable data for this
 * execution, as opposed to a bare `meta.json` record, broken out by kind so
 * callers can rank a log-backed candidate ahead of a workPlan-only one.
 * Checked cheaply: an already-loaded `StreamLogStore.has()` lookup is O(1)
 * in-memory, and `hasPersistedWorkPlan()` is a single stat, so this never
 * re-reads the full per-stream sidecar set.
 */
async function readMetaMatchDataPresence(
  snapshotStore: StreamSnapshotStore,
  streamId: StreamTabId,
  streamLogStore: Pick<StreamLogStore, 'keys' | 'has'> | undefined,
): Promise<MetaMatchDataPresence> {
  const hasLog = streamLogStore?.has(streamId) ?? false;
  return {
    hasLog,
    // hasWorkPlan is irrelevant once hasLog is true (log rank always wins in
    // pickBestMetaMatch) — skip the disk stat in that case, since this runs
    // on the hot path #7299 already had to bound for fd pressure.
    hasWorkPlan: hasLog || (await snapshotStore.hasPersistedWorkPlan(streamId)),
  };
}

/**
 * Disambiguate multiple persisted streams whose sidecar `meta.json` all
 * reference the same `executionId` (e.g. a parent orchestrator tab and a
 * `bash@tool#executionId` child stream). Ranks candidates by data kind: a
 * real `streamLogs` entry always outranks a `workPlan.json`-only match,
 * which in turn outranks a bare metadata match (scan order only breaks ties
 * within the same rank), so a log-backed candidate is never shadowed by an
 * earlier-ordered workPlan-only one.
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
      ...(await readMetaMatchDataPresence(
        snapshotStore,
        candidate.streamId,
        streamLogStore,
      )),
    }),
    { concurrency: META_SCAN_CONCURRENCY },
  );
  return (
    withData.find((entry) => entry.hasLog)?.candidate.streamId ??
    withData.find((entry) => entry.hasWorkPlan)?.candidate.streamId ??
    candidates[0].streamId
  );
}

/**
 * Resolve an execution id to the stream id used by transcript sidecars.
 *
 * The sidecar metadata is canonical. The suffix checks preserve compatibility
 * with older records and child-stream prefixes that cannot be derived from the
 * top-level agent/model pair.
 *
 * Decide-once-carry-as-data (#7469): when a `streamDataMeta` resolution below
 * finds exactly one meta-matched candidate (no disambiguation needed), it's
 * cached onto the execution's own metadata (`writeExecutionStreamId`) so a
 * later call for the same executionId can skip straight to a single cheap
 * read instead of re-scanning every persisted stream. A multi-candidate
 * resolution is deliberately NOT cached: `pickBestMetaMatch`'s ranking
 * depends on which `streamLogStore`/workPlan data happens to be available to
 * *this* call, so an earlier call without a loaded `streamLogStore` could
 * settle on a worse (non-log-backed) candidate than a later call that does
 * have one — caching that would permanently shadow the better answer. The
 * suffix/fallback sources further below are heuristic guesses for when no
 * stream's meta.json actually claims this executionId at all, and caching a
 * guess as if it were a confirmed match could pin a wrong answer too.
 */
export async function resolvePersistedStreamIdForExecution(
  executionId: ExecutionId,
  options: PersistedStreamIdResolverOptions = {},
): Promise<PersistedStreamIdResolution | null> {
  const cachedStreamId = (await getExecutionStore(executionId).readMeta())
    ?.streamId;
  if (cachedStreamId) {
    return { streamId: cachedStreamId, source: 'executionMeta' };
  }

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
    if (metaCandidates.length === 1) {
      await writeExecutionStreamId(executionId, streamId);
    }
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
