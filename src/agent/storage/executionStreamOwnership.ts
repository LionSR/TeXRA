// Node imports
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';

// Third-party imports
import pMap from 'p-map';

// Internal imports
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import {
  ExecutionIdSchema,
  StreamTabMetaSchema,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  canUseStreamDataDir,
  STREAM_DATA_KEYS,
  streamDataDir,
} from '@transcript/streamDataPaths';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';

// Local imports
import { getExecutionStore } from './ExecutionKVStore';

const log = createLog('ExecutionStreamOwnership');
const OWNERSHIP_SCAN_CONCURRENCY = 8;
const STREAM_OWNERSHIP_LOCKS_DIR = 'streamOwnershipLocks';
const heldOwnershipFences = new AsyncLocalStorage<ReadonlySet<StreamTabId>>();
const validatedDeletionFences = new AsyncLocalStorage<
  ReadonlyMap<StreamTabId, ExecutionId | undefined>
>();

export interface ModernStreamClaims {
  readonly byStream: ReadonlyMap<StreamTabId, readonly ExecutionId[]>;
  readonly unreadable: boolean;
}

async function readExecutionDirs(): Promise<[string, number][]> {
  try {
    return await StorageFS.readDir(RUNS_STORAGE_DIR);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

/** Read current execution-metadata stream claims without migration policy. */
export async function readModernStreamClaims(
  entries?: readonly [string, number][],
): Promise<ModernStreamClaims> {
  let unreadable = false;
  const matches = (
    await pMap(
      entries ?? (await readExecutionDirs()),
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
            `Could not read execution metadata while checking stream ownership: ${toErrorMessage(error)}`,
            { data: { executionId: executionId.data, error } },
          );
          return undefined;
        }
      },
      { concurrency: OWNERSHIP_SCAN_CONCURRENCY },
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

/** Read the exact sidecar owner for one stream, rejecting malformed evidence. */
export async function readStreamSidecarOwner(
  streamId: StreamTabId,
): Promise<ExecutionId | undefined> {
  const raw = await new KVStore(streamDataDir(streamId)).read(
    STREAM_DATA_KEYS.META,
  );
  if (raw === undefined) return undefined;
  return StreamTabMetaSchema.parse(raw).executionId;
}

/** Serialize ownership validation and mutation for one persisted stream. */
export function runWithExecutionStreamOwnershipFence<T>(
  streamId: StreamTabId,
  operation: () => Promise<T>,
): Promise<T> {
  if (!canUseStreamDataDir(streamId)) {
    return Promise.reject(
      new Error(
        `Stream ${streamId} cannot participate in persisted ownership.`,
      ),
    );
  }
  const held = heldOwnershipFences.getStore();
  if (held?.has(streamId)) return operation();
  const lockPath = path.join(
    platform().storage.getStoragePath(),
    STREAM_OWNERSHIP_LOCKS_DIR,
    encodeURIComponent(streamId),
  );
  return platform().fileLocks.runExclusive(lockPath, () =>
    heldOwnershipFences.run(new Set([...(held ?? []), streamId]), operation),
  );
}

/** Freshly prove persisted ownership and keep that proof fenced through delete. */
export function runWithValidatedExecutionStreamDeletion<T>(
  streamId: StreamTabId,
  executionId: ExecutionId | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const validated = validatedDeletionFences.getStore();
  if (validated?.has(streamId)) {
    const validatedExecutionId = validated.get(streamId);
    if (executionId && validatedExecutionId !== executionId) {
      return Promise.reject(
        new Error(`Stream ${streamId} was validated for another execution.`),
      );
    }
    return operation();
  }
  return runWithExecutionStreamOwnershipFence(streamId, async () => {
    const [claims, sidecarOwner] = await Promise.all([
      readModernStreamClaims(),
      readStreamSidecarOwner(streamId),
    ]);
    const streamClaims = claims.byStream.get(streamId) ?? [];
    let valid: boolean;
    if (executionId) {
      const ownerMeta =
        streamClaims.length === 0 && sidecarOwner === executionId
          ? await getExecutionStore(executionId).readMetaStrict()
          : null;
      valid =
        !claims.unreadable &&
        ((streamClaims.length === 1 &&
          streamClaims[0] === executionId &&
          (sidecarOwner === undefined || sidecarOwner === executionId)) ||
          (streamClaims.length === 0 &&
            sidecarOwner === executionId &&
            ownerMeta?.streamId !== undefined &&
            ownerMeta.streamId !== streamId));
    } else {
      const sidecarOwnerMeta = sidecarOwner
        ? await getExecutionStore(sidecarOwner).readMetaStrict()
        : null;
      valid =
        !claims.unreadable &&
        streamClaims.length === 0 &&
        (sidecarOwner === undefined ||
          sidecarOwnerMeta === null ||
          (sidecarOwnerMeta.streamId !== undefined &&
            sidecarOwnerMeta.streamId !== streamId));
    }
    if (!valid) {
      throw new Error(
        `Stream ${streamId} does not have freshly validated persisted ownership.`,
      );
    }
    const next = new Map(validated ?? []);
    next.set(streamId, executionId);
    return validatedDeletionFences.run(next, operation);
  });
}

/** Reject a new metadata claim when persisted evidence names another owner. */
export async function assertExecutionStreamClaimAvailable(
  streamId: StreamTabId,
  executionId: ExecutionId,
): Promise<void> {
  const [claims, sidecarOwner] = await Promise.all([
    readModernStreamClaims(),
    readStreamSidecarOwner(streamId),
  ]);
  const claimedByAnotherExecution = (claims.byStream.get(streamId) ?? []).some(
    (claimant) => claimant !== executionId,
  );
  if (
    claims.unreadable ||
    claimedByAnotherExecution ||
    (sidecarOwner !== undefined && sidecarOwner !== executionId)
  ) {
    throw new Error(
      `Stream ${streamId} already has another or unreadable persisted execution owner.`,
    );
  }
}
