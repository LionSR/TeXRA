import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

const autoCompactByStream = new Map<StreamTabId, boolean>();
const pendingCompactNow = new Set<StreamTabId>();

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
  return autoCompactByStream.get(streamId) ?? false;
}

export function requestCompactNow(streamId: StreamTabId): void {
  pendingCompactNow.add(streamId);
}

export function consumeCompactNow(streamId: StreamTabId): boolean {
  if (!pendingCompactNow.has(streamId)) {
    return false;
  }
  pendingCompactNow.delete(streamId);
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
