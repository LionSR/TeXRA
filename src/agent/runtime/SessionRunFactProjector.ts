import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  ExtendedTokenUsageStatsSchema,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { isObject } from '@utils/core';

import { fromRunFactDomainKey } from './runFactEvents';
import type { SessionEventHub } from './SessionEventHub';

type UpdateStreamUsagePayload = ProgressEventPayloads['updateStreamUsage'];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a raw `usage` session-event `data` payload into the typed
 * `updateStreamUsage` progress payload. Shared by this projector and the CLI
 * TUI's direct subscriber (`subscribeRuntimeHost.ts`) so the two consumers of
 * the same `usage` session event can't silently diverge on which usage
 * shapes they accept.
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

/**
 * Project run-scoped trace facts back onto the current host event surface.
 * Downstream progress handlers remain unchanged during the migration.
 */
export function attachSessionRunFactProjector(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
  projectedStreamId: StreamTabId,
): () => void {
  return events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      if (sessionEvent.streamId !== projectedStreamId) return;
      const { event, streamId } = sessionEvent;

      if (event.type === 'usage') {
        const payload = toUpdateStreamUsagePayload(event.data, streamId);
        if (payload) runtimeHost.emit('updateStreamUsage', payload);
        return;
      }

      if (event.type !== 'domain') return;
      const factName = fromRunFactDomainKey(event.key);
      if (!factName || !isObject(event.data)) return;
      runtimeHost.emit(
        factName,
        event.data as ProgressEventPayloads[typeof factName],
      );
    },
    { scope: 'run', streamId: projectedStreamId, types: ['domain', 'usage'] },
  );
}
