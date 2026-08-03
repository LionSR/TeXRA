/**
 * The single legacy identity boundary (#9590 Stage 3). Every historical
 * scan/decoder that maps between executions and persisted streams without
 * registration provenance lives here: the sidecar directory scan
 * (`scanPersistedStreamsForExecution`), the `#executionId` stream-name suffix
 * match, and the suffix-derived ownership check that guards deletion and
 * restart repair (`legacyExecutionIdFromStreamSuffix`). Production code
 * outside this module never scans sidecars, decodes suffixes, or probes
 * alternate roots — it resolves identity from registered execution metadata
 * (`registeredStreamId`) or calls one of these entry points.
 *
 * Every legacy mechanism hit is logged at `warn` naming the mechanism, so
 * real-world reliance on legacy resolution is countable from logs. Confirmed
 * matches are additionally backfilled with
 * `streamIdSource: LEGACY_RESOLUTION` on the execution record.
 *
 * Ambiguity is explicit: when several persisted roots or suffix look-alikes
 * claim one execution, resolution reports the candidates and never selects
 * one by enumeration or lexical order.
 *
 * Retirement (#9590 Stage 7, tracked in #9627): dated, no earlier than the
 * 2026-11-01 legacy cohort — `streamData/` has no natural expiry, so a date
 * is the only available gate — and gated on the usage evidence this module's
 * warn log accumulates.
 */
import pMap from 'p-map';
import { ZodError } from 'zod';

import { createChannelTrace } from '@agent/trace';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { writeLegacyExecutionStreamId } from '@agent/storage/executionLifecycle';
import {
  EXECUTION_STREAM_ID_SOURCE,
  ExecutionIdSchema,
  registeredStreamId,
  type ExecutionId,
  type ExecutionMeta,
  type StreamTabId,
} from '@shared/schemas';
import { unique } from '@utils/core';

import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StreamLogStore } from './StreamLogStore';

const logger = createChannelTrace('LegacyIdentity');

export interface PersistedStreamIdResolution {
  /** Canonical stream when registration or persisted evidence proves one. */
  readonly streamId?: StreamTabId;
  /**
   * Other persisted candidates to try when a historical primary is empty.
   * Always stated: an empty list means "none exist by proof", so callers
   * never re-scan for alternates.
   */
  readonly fallbackStreamIds: readonly StreamTabId[];
  /** Exact-execution sidecars eligible for overlap-gated archive merging. */
  readonly exactExecutionCandidateStreamIds?: readonly StreamTabId[];
  /**
   * Several streams carry this execution's `#executionId` name suffix with no
   * metadata proving any of them canonical. Name resemblance is not
   * ownership, so none is selected and none may be merged.
   */
  readonly suffixCandidateStreamIds?: readonly StreamTabId[];
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
 * run descriptor, and report which of them claim `executionId`.
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
 * Retirement evidence (#9590 Stage 7 / #9627): one line per hit, with the
 * mechanism and identifiers as structured `data` so reliance is
 * machine-countable per mechanism/execution, not regexed out of prose.
 */
function logLegacyHit(
  mechanism: 'sidecar meta scan' | 'stream-name suffix' | 'suffix ownership',
  detail: string,
  data: Record<string, unknown>,
): void {
  logger.warn(`Legacy identity resolution fired (${mechanism}): ${detail}`, {
    data: { mechanism, ...data },
  });
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
 * archive root; unproven roots are exposed as exact-execution or suffix
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
    return { streamId: executionMeta.streamId, fallbackStreamIds: [] };
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
      logLegacyHit(
        'sidecar meta scan',
        mergeCandidateMetaMatched.length > 0
          ? `execution ${executionId} is claimed by ${mergeCandidateMetaMatched.length} unproven roots; no canonical stream selected`
          : `execution ${executionId} matches only proven child streams; no archive root`,
        {
          executionId,
          candidateStreamIds: mergeCandidateMetaMatched,
          associatedStreamIds,
        },
      );
      return {
        fallbackStreamIds: [],
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
    logLegacyHit(
      'sidecar meta scan',
      `execution ${executionId} resolved to stream ${streamId}`,
      { executionId, streamId },
    );
    return {
      streamId,
      fallbackStreamIds: orderedFallbacks(streamId, [
        ...mergeCandidateMetaMatched,
        ...suffixMatched,
      ]),
      ...(mergeCandidateMetaMatched.length > 0
        ? {
            exactExecutionCandidateStreamIds: mergeCandidateMetaMatched,
          }
        : {}),
      ...(associatedStreamIds.length > 0 ? { associatedStreamIds } : {}),
    };
  }

  // No sidecar metadata claims this execution; the only remaining legacy
  // evidence is the `#executionId` name suffix, checked across persisted
  // sidecars and transcript logs as one candidate set. One distinct match
  // resolves; several are reported as explicit ambiguity — never chosen
  // among by enumeration order.
  const suffixMatched = unique([
    ...findExecutionSuffixMatches(persistedStreams, executionId),
    ...(options.streamLogStore
      ? findExecutionSuffixMatches(options.streamLogStore.keys(), executionId)
      : []),
  ]);
  if (suffixMatched.length === 0) return null;
  if (suffixMatched.length > 1) {
    logLegacyHit(
      'stream-name suffix',
      `execution ${executionId} matches ${suffixMatched.length} streams by name suffix; no canonical stream selected`,
      { executionId, candidateStreamIds: suffixMatched },
    );
    return {
      fallbackStreamIds: [],
      suffixCandidateStreamIds: suffixMatched,
    };
  }
  logLegacyHit(
    'stream-name suffix',
    `execution ${executionId} resolved to stream ${suffixMatched[0]}`,
    { executionId, streamId: suffixMatched[0] },
  );
  return { streamId: suffixMatched[0], fallbackStreamIds: [] };
}

/** Recover the conventional execution suffix from a persisted stream id. */
function executionIdFromStream(stream: StreamTabId): ExecutionId | undefined {
  const separator = stream.lastIndexOf('#');
  const candidate = separator >= 0 ? stream.slice(separator + 1) : stream;
  const parsed = ExecutionIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Legacy ownership boundary (#9590 A2): a `#executionId` stream-name suffix is
 * a formatting hint, not authority over an execution directory. The derived id
 * is admitted only when registered execution metadata does not contradict it —
 * an execution whose birth registration names a different stream keeps its
 * directory even when an unrelated stream resembles it by suffix. Records
 * without registration provenance (pre-#9590 history, or a stream whose
 * sidecar was lost) keep the suffix-derived answer.
 *
 * `malformedMeta` states the caller's stance on a present-but-unparseable
 * record, which may well register another owner stream (the parse failure is
 * logged at warn by the store):
 * - `'reject'` — deletion admission: corruption blocks the execution
 *   directory from being admitted, instead of reading as an absent legacy
 *   record.
 * - `'admit'` — restart repair: corruption cannot disprove the suffix, so
 *   mapping here must not throw. A corrupt record surfaces downstream: an
 *   in-flight repair candidate deliberately aborts the repair pass at its
 *   own strict settlement read, before any mutation; a settled historical
 *   stream is never consulted again, so its corruption stays inert.
 */
export async function legacyExecutionIdFromStreamSuffix(
  stream: StreamTabId,
  options: { readonly malformedMeta: 'reject' | 'admit' },
): Promise<ExecutionId | undefined> {
  const derived = executionIdFromStream(stream);
  if (derived === undefined) return undefined;
  const admit = (): ExecutionId => {
    logLegacyHit(
      'suffix ownership',
      `stream ${stream} admitted execution ${derived} by name suffix`,
      { executionId: derived, streamId: stream },
    );
    return derived;
  };
  let meta: ExecutionMeta | null;
  try {
    meta = await getExecutionStore(derived).readMetaStrict();
  } catch (error) {
    // Only a validation failure means "malformed record"; a storage read
    // failure proves nothing about ownership and must propagate rather than
    // silently admit (or silently withhold) an execution directory.
    if (!(error instanceof ZodError)) throw error;
    return options.malformedMeta === 'reject' ? undefined : admit();
  }
  const registered = registeredStreamId(meta);
  return registered !== undefined && registered !== stream
    ? undefined
    : admit();
}
