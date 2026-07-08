import {
  ExtendedTokenUsageStatsSchema,
  type StorageKey,
  type StreamTabId,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import { isObject } from '@utils/core';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a raw `usage` run-fact payload into the typed usage update form used by
 * host-neutral consumers. Keep this parser outside the legacy projection
 * module so fact-native UI paths do not depend on compatibility machinery.
 */
export function toUpdateStreamUsagePayload(
  data: unknown,
  fallbackStreamId: StreamTabId,
): UpdateStreamUsagePayload | undefined {
  if (!isObject(data)) return undefined;
  const storageKey = asString(data.storageKey);
  if (!storageKey) return undefined;
  const usage = ExtendedTokenUsageStatsSchema.safeParse(data.usage);
  if (!usage.success) return undefined;

  const streamId = asString(data.streamId) ?? fallbackStreamId;
  const executionId = asString(data.executionId);
  return {
    streamId: streamId as StreamTabId,
    storageKey: storageKey as StorageKey,
    ...(executionId ? { executionId } : {}),
    usage: usage.data,
  };
}
