import pMap from 'p-map';

import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { writeLegacyExecutionStreamId } from '@agent/storage/executionLifecycle';
import {
  EXECUTION_STREAM_ID_SOURCE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StreamLogStore } from './StreamLogStore';

type PersistedStreamIdResolutionSource =
  'executionMeta' | 'streamDataMeta' | 'streamDataSuffix' | 'streamLogsSuffix';

export interface PersistedStreamIdResolution {
  /** Canonical stream when registration or persisted evidence proves one. */
  readonly streamId?: StreamTabId;
  readonly source: PersistedStreamIdResolutionSource;
  /** Other persisted candidates to try when a historical primary is empty. */
  readonly fallbackStreamIds?: readonly StreamTabId[];
  /** Exact-execution sidecars eligible for overlap-gated archive merging. */
  readonly exactExecutionCandidateStreamIds?: readonly StreamTabId[];
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
  /** Exact execution matches not positively identified as child streams. */
  readonly mergeCandidateMetaMatched: StreamTabId[];
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
    mergeCandidateMetaMatched: scanned
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
 * branch. Confirmed legacy matches are annotated with their provenance, but
 * remain subject to the bounded scan because a later resume can add another
 * root sidecar. Only birth-time registrations use the constant-time path.
 *
 * `null` means no persisted stream carries this execution. A resolution with
 * no `streamId` exposes exact-execution candidates whose canonical owner is
 * unproven; callers must not substitute one of them. Callers that receive
 * `null` and have a derivable stream id own that compatibility substitution.
 */
export async function resolvePersistedStreamIdForExecution(
  executionId: ExecutionId,
  options: PersistedStreamIdResolverOptions = {},
): Promise<PersistedStreamIdResolution | null> {
  const executionMeta = await getExecutionStore(executionId).readMeta();
  if (
    executionMeta?.streamId &&
    executionMeta.streamIdSource === EXECUTION_STREAM_ID_SOURCE.REGISTRATION
  ) {
    return { streamId: executionMeta.streamId, source: 'executionMeta' };
  }

  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const { persistedStreams, metaMatched, mergeCandidateMetaMatched } =
    await scanPersistedStreamsForExecution(executionId, snapshotStore);

  if (metaMatched.length > 0) {
    const primaryCandidates =
      mergeCandidateMetaMatched.length > 0
        ? mergeCandidateMetaMatched
        : metaMatched;
    const streamId =
      primaryCandidates.length === 1 ? primaryCandidates[0] : undefined;
    if (metaMatched.length === 1 && streamId) {
      await writeLegacyExecutionStreamId(executionId, streamId);
    }
    if (!streamId) {
      // Exact execution metadata associates every candidate with this run, but
      // missing parent metadata does not prove which one owns the archive.
      // Data presence and lexical order are not canonical-ownership evidence.
      return {
        source: 'streamDataMeta',
        exactExecutionCandidateStreamIds: primaryCandidates,
      };
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
      ...(mergeCandidateMetaMatched.length > 0
        ? {
            exactExecutionCandidateStreamIds: mergeCandidateMetaMatched,
          }
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
