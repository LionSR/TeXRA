import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import {
  ExecutionIdSchema,
  registeredStreamId,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

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
 */
export async function legacyExecutionIdFromStreamSuffix(
  stream: StreamTabId,
): Promise<ExecutionId | undefined> {
  const derived = executionIdFromStream(stream);
  if (derived === undefined) return undefined;
  const registered = registeredStreamId(
    await getExecutionStore(derived).readMeta(),
  );
  return registered !== undefined && registered !== stream
    ? undefined
    : derived;
}
