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
import { writeLegacyExecutionStreamId } from './executionLifecycle';

const log = createLog('ExecutionStreamHealing');
const LEGACY_SIDECAR_SCAN_CONCURRENCY = 8;

interface LegacyStreamEvidence {
  readonly candidates: ReadonlyMap<ExecutionId, readonly StreamTabId[]>;
  readonly malformedExecutionIds: ReadonlySet<ExecutionId>;
  readonly unreadable: boolean;
}

export interface LegacyExecutionStreamRecovery {
  readonly streamId: StreamTabId | undefined;
  /** Ownership cannot be disproved safely during destructive index sweeps. */
  readonly ownershipUnknown: boolean;
}

async function readLegacyStreamEvidence(): Promise<LegacyStreamEvidence> {
  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(STREAM_DATA_DIR);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        candidates: new Map(),
        malformedExecutionIds: new Set(),
        unreadable: false,
      };
    }
    throw error;
  }

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
      { concurrency: LEGACY_SIDECAR_SCAN_CONCURRENCY },
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

/**
 * Create a one-scan healer for one execution or a batch execution listing.
 * Callers supply metadata they already read; evidence is loaded lazily, so an
 * all-modern batch never scans sidecars.
 */
export function createLegacyExecutionStreamHealer(): (
  executionId: ExecutionId,
  meta: ExecutionMeta,
) => Promise<LegacyExecutionStreamRecovery> {
  let evidencePromise: Promise<LegacyStreamEvidence> | undefined;
  return async (executionId, meta) => {
    if (meta.streamId) {
      return { streamId: meta.streamId, ownershipUnknown: false };
    }

    evidencePromise ??= readLegacyStreamEvidence();
    const evidence = await evidencePromise;
    const candidates = evidence.candidates.get(executionId) ?? [];
    const ownershipUnknown =
      evidence.unreadable ||
      evidence.malformedExecutionIds.has(executionId) ||
      candidates.length > 1;
    if (ownershipUnknown || candidates.length === 0) {
      return { streamId: undefined, ownershipUnknown };
    }
    return {
      streamId: await writeLegacyExecutionStreamId(executionId, candidates[0]),
      ownershipUnknown: false,
    };
  };
}

/**
 * Recover the one durable execution→stream edge for a pre-#9520 execution.
 * Current rows return directly from metadata. Historical rows are stamped only
 * when exactly one well-formed stream sidecar names the execution; ambiguous
 * or unreadable evidence remains unstamped.
 *
 * Compatibility reader introduced by #11337 on 2026-08-31 for released-host
 * rows written before 2026-08-01. Remove on or after 2026-11-01, once those
 * workspace records leave the three-month supported recovery window.
 */
export async function recoverLegacyExecutionStreamId(
  executionId: ExecutionId,
  meta?: ExecutionMeta,
): Promise<StreamTabId | undefined> {
  const existing = meta ?? (await getExecutionStore(executionId).readMeta());
  if (!existing) return undefined;
  return (await createLegacyExecutionStreamHealer()(executionId, existing))
    .streamId;
}
