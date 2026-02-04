import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

/**
 * Module-level state for per-stream compaction controls.
 *
 * This module assumes a single-threaded event loop (VS Code extension host).
 * Requests are queued and consumed on the next tool-use cycle.
 */
const autoCompactByStream = new Map<StreamTabId, boolean>();
const pendingCompactNow = new Map<StreamTabId, number>();

export function setAutoCompactEnabled(
  streamId: StreamTabId,
  enabled: boolean,
): void {
  autoCompactByStream.set(streamId, enabled);
  bus.emit('updateAutoCompactState', { streamId, autoCompactEnabled: enabled });
}

export function toggleAutoCompact(streamId: StreamTabId): boolean {
  const current = autoCompactByStream.get(streamId) ?? false;
  const next = !current;
  setAutoCompactEnabled(streamId, next);
  return next;
}

export function isAutoCompactEnabled(streamId: StreamTabId): boolean {
  return autoCompactByStream.get(streamId) ?? true;
}

export function requestCompactNow(streamId: StreamTabId): void {
  const count = pendingCompactNow.get(streamId) ?? 0;
  pendingCompactNow.set(streamId, count + 1);
}

export function consumeCompactNow(streamId: StreamTabId): boolean {
  const count = pendingCompactNow.get(streamId) ?? 0;
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    pendingCompactNow.delete(streamId);
  } else {
    pendingCompactNow.set(streamId, count - 1);
  }
  return true;
}

export function clearAutoCompactState(streamId: StreamTabId): void {
  autoCompactByStream.delete(streamId);
  pendingCompactNow.delete(streamId);
}

export function clearAllAutoCompactState(): void {
  autoCompactByStream.clear();
  pendingCompactNow.clear();
}
