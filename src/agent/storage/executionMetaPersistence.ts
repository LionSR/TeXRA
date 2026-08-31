// Third-party imports
import pMap from 'p-map';

// Internal imports
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import {
  StreamTabMetaSchema,
  type ExecutionId,
  type ExecutionMeta,
  type StreamTabId,
} from '@shared/schemas';
import {
  canUseStreamDataDir,
  decodeStreamId,
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from '@transcript/streamDataPaths';
import { isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';

// Local imports
import { getExecutionStore } from './ExecutionKVStore';
import { runWithExecutionMetaWriteFence } from './executionLifecycle';
import {
  readModernStreamClaims,
  readStreamSidecarOwner,
  runWithExecutionStreamOwnershipFence,
  runWithValidatedExecutionStreamDeletion,
  type ModernStreamClaims,
} from './executionStreamOwnership';

const log = createLog('ExecutionStreamHealing');
const LEGACY_SCAN_CONCURRENCY = 8;

interface LegacyStreamEvidence {
  readonly candidates: ReadonlyMap<ExecutionId, readonly StreamTabId[]>;
  readonly malformedExecutionIds: ReadonlySet<ExecutionId>;
  readonly unreadable: boolean;
}

interface LegacyExecutionStreamRecovery {
  readonly streamId: StreamTabId | undefined;
  /** Ownership cannot be disproved safely during destructive index sweeps. */
  readonly ownershipUnknown: boolean;
}

async function readDirOrEmpty(path: string): Promise<[string, number][]> {
  try {
    return await StorageFS.readDir(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

async function readLegacyStreamEvidence(): Promise<LegacyStreamEvidence> {
  const entries = await readDirOrEmpty(STREAM_DATA_DIR);
  let unreadable = false;
  const malformedExecutionIds = new Set<ExecutionId>();
  const matches = (
    await pMap(
      entries,
      async ([encoded, type]): Promise<
        readonly [ExecutionId, StreamTabId] | undefined
      > => {
        if (!isDirectory(type)) return undefined;
        const streamId = decodeStreamId(encoded) as StreamTabId | undefined;
        if (
          !streamId ||
          !canUseStreamDataDir(streamId) ||
          encodeURIComponent(streamId) !== encoded
        ) {
          unreadable = true;
          return undefined;
        }
        let raw: unknown;
        try {
          raw = await new KVStore(streamDataDir(streamId)).read(
            STREAM_DATA_KEYS.META,
          );
        } catch (error) {
          unreadable = true;
          log.warn(
            `Could not read historical stream metadata while recovering execution links: ${toErrorMessage(error)}`,
            { data: { streamId, error } },
          );
          return undefined;
        }
        if (raw === undefined) return undefined;
        const parsed = StreamTabMetaSchema.safeParse(raw);
        if (!parsed.success) {
          if (isObject(raw) && typeof raw.executionId === 'string') {
            malformedExecutionIds.add(raw.executionId as ExecutionId);
          } else {
            // The owner of malformed evidence cannot be disproved.
            unreadable = true;
          }
          return undefined;
        }
        return parsed.data.executionId
          ? [parsed.data.executionId, streamId]
          : undefined;
      },
      { concurrency: LEGACY_SCAN_CONCURRENCY },
    )
  ).filter(
    (match): match is readonly [ExecutionId, StreamTabId] =>
      match !== undefined,
  );
  const candidates = new Map<ExecutionId, StreamTabId[]>();
  for (const [executionId, streamId] of matches) {
    const streams = candidates.get(executionId);
    if (streams) streams.push(streamId);
    else candidates.set(executionId, [streamId]);
  }
  return { candidates, malformedExecutionIds, unreadable };
}

async function stampRecoveredStreamId(
  executionId: ExecutionId,
  streamId: StreamTabId,
  claims: ModernStreamClaims,
): Promise<StreamTabId | undefined> {
  return runWithExecutionMetaWriteFence(executionId, () =>
    runWithExecutionStreamOwnershipFence(streamId, async () => {
      const sidecarOwner = await readStreamSidecarOwner(streamId);
      const claimedByAnotherExecution = (
        claims.byStream.get(streamId) ?? []
      ).some((claimant) => claimant !== executionId);
      if (
        claims.unreadable ||
        sidecarOwner !== executionId ||
        claimedByAnotherExecution
      ) {
        return undefined;
      }

      const store = getExecutionStore(executionId);
      const existing = await store.readMeta();
      if (!existing) {
        throw new Error(`Execution metadata not found for ${executionId}`);
      }
      if (existing.streamId) return existing.streamId;
      await store.writeMeta({ ...existing, streamId });
      return streamId;
    }),
  );
}

/**
 * Create one operation-scoped healer for the execution metadata read boundary.
 * Evidence is loaded lazily, so modern reads never scan compatibility data and
 * a bulk operation pays for at most one sidecar and one execution scan.
 */
function createLegacyExecutionStreamHealer(
  readClaims: () => Promise<ModernStreamClaims>,
): (
  executionId: ExecutionId,
  meta: ExecutionMeta,
  validateModernClaims: boolean,
) => Promise<LegacyExecutionStreamRecovery> {
  let sidecarEvidence: Promise<LegacyStreamEvidence> | undefined;
  let modernClaims: Promise<ModernStreamClaims> | undefined;
  return async (executionId, meta, validateModernClaims) => {
    if (meta.streamId) {
      if (!validateModernClaims) {
        return { streamId: meta.streamId, ownershipUnknown: false };
      }
      modernClaims ??= readClaims();
      const claims = await modernClaims;
      const claimedByAnotherExecution = (
        claims.byStream.get(meta.streamId) ?? []
      ).some((claimant) => claimant !== executionId);
      return {
        streamId: meta.streamId,
        ownershipUnknown: claims.unreadable || claimedByAnotherExecution,
      };
    }

    sidecarEvidence ??= readLegacyStreamEvidence();
    const evidence = await sidecarEvidence;
    const candidates = evidence.candidates.get(executionId) ?? [];
    const sidecarOwnershipUnknown =
      evidence.unreadable ||
      evidence.malformedExecutionIds.has(executionId) ||
      candidates.length > 1;
    if (sidecarOwnershipUnknown || candidates.length === 0) {
      return {
        streamId: undefined,
        ownershipUnknown: sidecarOwnershipUnknown,
      };
    }

    modernClaims ??= readClaims();
    const claims = await modernClaims;
    const streamId = await stampRecoveredStreamId(
      executionId,
      candidates[0],
      claims,
    );
    return {
      streamId,
      ownershipUnknown: streamId === undefined,
    };
  };
}

/** A durable stream owner cannot be selected safely from persisted evidence. */
class ExecutionStreamOwnershipUnknownError extends Error {
  constructor(readonly executionId: ExecutionId) {
    super(
      `Execution ${executionId} has ambiguous or unreadable persisted stream ownership.`,
    );
    this.name = 'ExecutionStreamOwnershipUnknownError';
  }
}

interface ExecutionMetaReader {
  read(executionId: ExecutionId): Promise<ExecutionMeta | null>;
  readStrict(executionId: ExecutionId): Promise<ExecutionMeta | null>;
  /** Validate persisted stream claims before destructive adjacent cleanup. */
  readForDeletion(executionId: ExecutionId): Promise<ExecutionMeta | null>;
  /** Keep stream ownership fenced from validation through destructive commit. */
  withStreamForDeletion(
    executionId: ExecutionId,
    operation: (streamId: StreamTabId) => Promise<void>,
  ): Promise<void>;
}

/**
 * Build one execution-metadata read boundary, optionally shared by a batch.
 * Every successful read returns the current metadata shape. A pre-#9520 row is
 * normalized and written through here only when persisted sidecars provide one
 * unique owner that no modern execution metadata already claims.
 *
 * Compatibility reader introduced by #11337 on 2026-08-31 for released-host
 * rows written before 2026-08-01. Remove on or after 2026-11-01, once those
 * workspace records leave the three-month supported recovery window.
 *
 * @internal Storage-only operation scope; never expose through the host barrel.
 */
export function createExecutionMetaReader(
  readClaims: () => Promise<ModernStreamClaims> = readModernStreamClaims,
): ExecutionMetaReader {
  const healLegacyStreamId = createLegacyExecutionStreamHealer(readClaims);
  const normalize = async (
    executionId: ExecutionId,
    meta: ExecutionMeta | null,
    mode: 'permissive' | 'strict' | 'deletion',
  ): Promise<ExecutionMeta | null> => {
    if (!meta) return meta;
    const recovery = await healLegacyStreamId(
      executionId,
      meta,
      mode === 'deletion',
    );
    if (recovery.ownershipUnknown && mode !== 'permissive') {
      throw new ExecutionStreamOwnershipUnknownError(executionId);
    }
    return recovery.streamId ? { ...meta, streamId: recovery.streamId } : meta;
  };
  const readForDeletion = async (
    executionId: ExecutionId,
  ): Promise<ExecutionMeta | null> =>
    normalize(
      executionId,
      await getExecutionStore(executionId).readMetaStrict(),
      'deletion',
    );
  return {
    read: async (executionId) =>
      normalize(
        executionId,
        await getExecutionStore(executionId).readMeta(),
        'permissive',
      ),
    readStrict: async (executionId) =>
      normalize(
        executionId,
        await getExecutionStore(executionId).readMetaStrict(),
        'strict',
      ),
    readForDeletion,
    withStreamForDeletion: async (executionId, operation) => {
      const meta = await readForDeletion(executionId);
      const streamId = meta?.streamId;
      if (!streamId) return;
      await runWithValidatedExecutionStreamDeletion(streamId, executionId, () =>
        operation(streamId),
      );
    },
  };
}

/** Build one storage-owned batch of fenced execution-stream deletions. */
export function createExecutionStreamDeletionBatch(
  operation: (streamId: StreamTabId) => Promise<void>,
): (executionId: ExecutionId) => Promise<void> {
  const reader = createExecutionMetaReader();
  return (executionId) => reader.withStreamForDeletion(executionId, operation);
}

/** Read and normalize one execution metadata record within storage. */
export function readExecutionMeta(
  executionId: ExecutionId,
): Promise<ExecutionMeta | null> {
  return createExecutionMetaReader().read(executionId);
}

/** Resolve the durable execution→stream edge and its normalized metadata. */
export async function readExecutionStreamReference(
  executionId: ExecutionId,
): Promise<{
  readonly streamId: StreamTabId;
  readonly meta: ExecutionMeta;
} | null> {
  const meta = await readExecutionMeta(executionId);
  return meta?.streamId ? { streamId: meta.streamId, meta } : null;
}

/** Resolve the durable execution→stream edge for a single host operation. */
export async function readExecutionStreamId(
  executionId: ExecutionId,
): Promise<StreamTabId | undefined> {
  return (await readExecutionStreamReference(executionId))?.streamId;
}
