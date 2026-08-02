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

export interface PersistedStreamIdResolution {
  /** Canonical stream when registration or persisted evidence proves one. */
  readonly streamId?: StreamTabId;
  /** Other persisted candidates to try when a historical primary is empty. */
  readonly fallbackStreamIds?: readonly StreamTabId[];
  /** Exact-execution sidecars eligible for overlap-gated archive merging. */
  readonly exactExecutionCandidateStreamIds?: readonly StreamTabId[];
  /** Proven child associations excluded from archive ownership and row reads. */
  readonly associatedStreamIds?: readonly StreamTabId[];
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
  /** Exact execution matches positively identified as child streams. */
  readonly childMetaMatched: StreamTabId[];
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
    childMetaMatched: scanned
      .filter(
        (candidate) =>
          candidate.association.executionId === executionId &&
          candidate.association.parentStreamId !== undefined,
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
  const { persistedStreams, mergeCandidateMetaMatched, childMetaMatched } =
    await scanPersistedStreamsForExecution(executionId, snapshotStore);
  const excludedChildren = new Set(childMetaMatched);
  const suffixMatched = findExecutionSuffixMatches(
    [...persistedStreams, ...(options.streamLogStore?.keys() ?? [])],
    executionId,
  ).filter((candidate) => !excludedChildren.has(candidate));
  return orderedFallbacks(primary, [
    ...mergeCandidateMetaMatched,
    ...suffixMatched,
  ]);
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
 * no `streamId` means persisted associations exist but prove no canonical
 * archive root; when unproven roots exist, they are exposed as exact-execution
 * candidates. Callers must not substitute a candidate or proven child.
 * Callers that receive `null` and have a derivable stream id own that
 * compatibility substitution.
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
    return { streamId: executionMeta.streamId };
  }

  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const {
    persistedStreams,
    metaMatched,
    mergeCandidateMetaMatched,
    childMetaMatched,
  } = await scanPersistedStreamsForExecution(executionId, snapshotStore);

  if (metaMatched.length > 0) {
    // A sole delegated stream can itself be the historical execution being
    // resolved. Several proven children, however, are not competing archive
    // roots and must never enter overlap-gated merging.
    const soleDelegatedStream =
      mergeCandidateMetaMatched.length === 0 && metaMatched.length === 1
        ? metaMatched[0]
        : undefined;
    const streamId =
      mergeCandidateMetaMatched.length === 1
        ? mergeCandidateMetaMatched[0]
        : soleDelegatedStream;
    const associatedStreamIds = childMetaMatched.filter(
      (candidate) => candidate !== streamId,
    );
    if (metaMatched.length === 1 && streamId) {
      await writeLegacyExecutionStreamId(executionId, streamId);
    }
    if (!streamId) {
      // Exact execution metadata associates every root candidate with this
      // run, but missing parent metadata does not prove which root owns the
      // archive. Data presence and lexical order are not canonical-ownership
      // evidence. When every match is a proven child there are no candidates.
      return {
        ...(mergeCandidateMetaMatched.length > 0
          ? {
              exactExecutionCandidateStreamIds: mergeCandidateMetaMatched,
            }
          : {}),
        ...(associatedStreamIds.length > 0 ? { associatedStreamIds } : {}),
      };
    }
    const excludedChildren = new Set(associatedStreamIds);
    const suffixMatched = findExecutionSuffixMatches(
      [...persistedStreams, ...(options.streamLogStore?.keys() ?? [])],
      executionId,
    ).filter((candidate) => !excludedChildren.has(candidate));
    const fallbackStreamIds = orderedFallbacks(streamId, [
      ...mergeCandidateMetaMatched,
      ...suffixMatched,
    ]);
    return {
      streamId,
      ...(fallbackStreamIds.length > 0 ? { fallbackStreamIds } : {}),
      ...(mergeCandidateMetaMatched.length > 0
        ? {
            exactExecutionCandidateStreamIds: mergeCandidateMetaMatched,
          }
        : {}),
      ...(associatedStreamIds.length > 0 ? { associatedStreamIds } : {}),
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
      ...(fallbackStreamIds.length > 0 ? { fallbackStreamIds } : {}),
    };
  }

  return null;
}
