import {
  ExecutionIdSchema,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

/** Recover the conventional execution suffix from a persisted stream id. */
export function executionIdFromStream(
  stream: StreamTabId,
): ExecutionId | undefined {
  const separator = stream.lastIndexOf('#');
  const candidate = separator >= 0 ? stream.slice(separator + 1) : stream;
  const parsed = ExecutionIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
