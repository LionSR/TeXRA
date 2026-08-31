// Third-party imports
import pMap from 'p-map';

// Internal imports
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import {
  ExecutionIdSchema,
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
import { writeLegacyExecutionStreamId } from './executionLifecycle';

const log = createLog('ExecutionStreamHealing');
const LEGACY_SCAN_CONCURRENCY = 8;

interface LegacyStreamEvidence {
  readonly candidates: ReadonlyMap<ExecutionId, readonly StreamTabId[]>;
  readonly malformedExecutionIds: ReadonlySet<ExecutionId>;
  readonly unreadable: boolean;
}

interface ModernStreamClaims {
  readonly byStream: ReadonlyMap<StreamTabId, readonly ExecutionId[]>;
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

async function readModernStreamClaims(): Promise<ModernStreamClaims> {
  const entries = await readDirOrEmpty(RUNS_STORAGE_DIR);
  let unreadable = false;
  const matches = (
    await pMap(
      entries,
      async ([name, type]): Promise<
        readonly [StreamTabId, ExecutionId] | undefined
      > => {
        if (!isDirectory(type)) return undefined;
        const executionId = ExecutionIdSchema.safeParse(name);
        if (!executionId.success) return undefined;
        try {
          const meta = await getExecutionStore(
            executionId.data,
          ).readMetaStrict();
          return meta?.streamId ? [meta.streamId, executionId.data] : undefined;
        } catch (error) {
          unreadable = true;
          log.warn(
            `Could not read execution metadata while checking historical stream ownership: ${toErrorMessage(error)}`,
            { data: { executionId: executionId.data, error } },
          );
          return undefined;
        }
      },
      { concurrency: LEGACY_SCAN_CONCURRENCY },
    )
  ).filter(
    (match): match is readonly [StreamTabId, ExecutionId] =>
      match !== undefined,
  );
  const byStream = new Map<StreamTabId, ExecutionId[]>();
  for (const [streamId, executionId] of matches) {
    const claims = byStream.get(streamId);
    if (claims) claims.push(executionId);
    else byStream.set(streamId, [executionId]);
  }
  return { byStream, unreadable };
}

/**
 * Create one operation-scoped healer for the execution metadata read boundary.
 * Evidence is loaded lazily, so modern reads never scan compatibility data and
 * a bulk operation pays for at most one sidecar and one execution scan.
 */
function createLegacyExecutionStreamHealer(): (
  executionId: ExecutionId,
  meta: ExecutionMeta,
) => Promise<LegacyExecutionStreamRecovery> {
  let sidecarEvidence: Promise<LegacyStreamEvidence> | undefined;
  let modernClaims: Promise<ModernStreamClaims> | undefined;
  return async (executionId, meta) => {
    if (meta.streamId) {
      return { streamId: meta.streamId, ownershipUnknown: false };
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

    modernClaims ??= readModernStreamClaims();
    const claims = await modernClaims;
    const claimedByAnotherExecution = (
      claims.byStream.get(candidates[0]) ?? []
    ).some((claimant) => claimant !== executionId);
    if (claims.unreadable || claimedByAnotherExecution) {
      return { streamId: undefined, ownershipUnknown: true };
    }
    return {
      streamId: await writeLegacyExecutionStreamId(executionId, candidates[0]),
      ownershipUnknown: false,
    };
  };
}

/** A durable stream owner cannot be selected safely from persisted evidence. */
class ExecutionStreamOwnershipUnknownError extends Error {
  constructor(readonly executionId: ExecutionId) {
    super(
      `Execution ${executionId} has ambiguous or unreadable historical stream ownership.`,
    );
    this.name = 'ExecutionStreamOwnershipUnknownError';
  }
}

export interface ExecutionMetaReader {
  read(executionId: ExecutionId): Promise<ExecutionMeta | null>;
  readStrict(executionId: ExecutionId): Promise<ExecutionMeta | null>;
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
 */
export function createExecutionMetaReader(): ExecutionMetaReader {
  const healLegacyStreamId = createLegacyExecutionStreamHealer();
  const normalize = async (
    executionId: ExecutionId,
    meta: ExecutionMeta | null,
    strict: boolean,
  ): Promise<ExecutionMeta | null> => {
    if (!meta || meta.streamId) return meta;
    const recovery = await healLegacyStreamId(executionId, meta);
    if (recovery.streamId) {
      return { ...meta, streamId: recovery.streamId };
    }
    if (strict && recovery.ownershipUnknown) {
      throw new ExecutionStreamOwnershipUnknownError(executionId);
    }
    return meta;
  };
  return {
    read: async (executionId) =>
      normalize(
        executionId,
        await getExecutionStore(executionId).readMeta(),
        false,
      ),
    readStrict: async (executionId) =>
      normalize(
        executionId,
        await getExecutionStore(executionId).readMetaStrict(),
        true,
      ),
  };
}

/** Read and normalize one execution metadata record. */
export function readExecutionMeta(
  executionId: ExecutionId,
): Promise<ExecutionMeta | null> {
  return createExecutionMetaReader().read(executionId);
}
