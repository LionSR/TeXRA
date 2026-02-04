import { DEFAULT_COMPACTION_THRESHOLD_PERCENT } from '@agent/modelHandlers/contextManagementConstants';
import { getConfig } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

const autoCompactByStream = new Map<StreamTabId, boolean>();

export function isAutoCompactEnabled(streamId: StreamTabId): boolean {
  const existing = autoCompactByStream.get(streamId);
  if (existing !== undefined) {
    return existing;
  }
  const thresholdPercent = getConfig<number>(
    'texra.model.compactionThresholdPercent',
    DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  );
  return thresholdPercent > 0;
}

export function setAutoCompactEnabled(
  streamId: StreamTabId,
  enabled: boolean,
): boolean {
  autoCompactByStream.set(streamId, enabled);
  bus.emit('updateAutoCompactState', { streamId, enabled });
  return enabled;
}

export function toggleAutoCompactEnabled(streamId: StreamTabId): boolean {
  return setAutoCompactEnabled(streamId, !isAutoCompactEnabled(streamId));
}

export function clearAutoCompactStateForStream(streamId: StreamTabId): void {
  autoCompactByStream.delete(streamId);
}

export function clearAllAutoCompactState(): void {
  autoCompactByStream.clear();
}
