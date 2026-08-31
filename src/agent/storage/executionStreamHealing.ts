import pMap from 'p-map';

import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import {
  StreamTabMetaSchema,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  decodeStreamId,
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from '@transcript/streamDataPaths';
import { isObject } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getExecutionStore } from './ExecutionKVStore';
import { writeLegacyExecutionStreamId } from './executionLifecycle';

const log = createLog('ExecutionStreamHealing');
const LEGACY_SIDECAR_SCAN_CONCURRENCY = 8;

/**
 * Recover the one durable execution→stream edge for a pre-#9520 execution.
 * Current rows return directly from metadata. Historical rows are stamped only
 * when exactly one well-formed stream sidecar names the execution; ambiguous
 * or unreadable evidence remains unstamped.
 *
 * Compatibility reader introduced by #11337 for rows written before 2026-08-01.
 * Remove it when those workspace records leave the supported recovery window.
 */
export async function recoverLegacyExecutionStreamId(
  executionId: ExecutionId,
): Promise<StreamTabId | undefined> {
  const meta = await getExecutionStore(executionId).readMetaStrict();
  if (!meta || meta.streamId) return meta?.streamId;

  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(STREAM_DATA_DIR);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }

  let evidenceUnreadable = false;
  const candidates = (
    await pMap(
      entries,
      async ([encoded, type]): Promise<StreamTabId | undefined> => {
        if (!isDirectory(type)) return undefined;
        const streamId = decodeStreamId(encoded) as StreamTabId | undefined;
        if (!streamId) {
          evidenceUnreadable = true;
          return undefined;
        }
        let raw: unknown;
        try {
          raw = await new KVStore(streamDataDir(streamId)).read(
            STREAM_DATA_KEYS.META,
          );
        } catch (error) {
          evidenceUnreadable = true;
          log.warn(
            `Could not read historical stream metadata while recovering execution ${executionId}: ${toErrorMessage(error)}`,
            { data: { executionId, streamId, error } },
          );
          return undefined;
        }
        if (raw === undefined) return undefined;
        const parsed = StreamTabMetaSchema.safeParse(raw);
        if (!parsed.success) {
          if (isObject(raw) && raw.executionId === executionId) {
            evidenceUnreadable = true;
          }
          return undefined;
        }
        return parsed.data.executionId === executionId ? streamId : undefined;
      },
      { concurrency: LEGACY_SIDECAR_SCAN_CONCURRENCY },
    )
  ).filter((streamId): streamId is StreamTabId => streamId !== undefined);

  if (evidenceUnreadable || candidates.length !== 1) return undefined;
  return writeLegacyExecutionStreamId(executionId, candidates[0]);
}
