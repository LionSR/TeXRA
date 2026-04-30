/** Per-stream bypass state for agent delegation proposals. */
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

const bypassedByStream = new Map<StreamTabId, boolean>();

function notifyBypassState(streamId: StreamTabId): void {
  bus.emit('updateSuperYoloBypassState', {
    streamId,
    bypassActive: bypassedByStream.get(streamId) ?? false,
    featureEnabled: true,
  });
}

/** Toggle per-stream proposal bypass. Returns new state. */
export function toggleProposalBypass(streamId: StreamTabId): boolean {
  const newState = !(bypassedByStream.get(streamId) ?? false);
  bypassedByStream.set(streamId, newState);
  notifyBypassState(streamId);
  return newState;
}

/** Check if proposals are bypassed for a specific stream. */
export function isProposalBypassedForStream(streamId: StreamTabId): boolean {
  return bypassedByStream.get(streamId) ?? false;
}

/** @internal Called by unified cleanup in index.ts */
export function _clearProposalBypassForStream(streamId: StreamTabId): void {
  bypassedByStream.delete(streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _clearAllProposalBypass(): void {
  bypassedByStream.clear();
}

/**
 * Clear all per-stream proposal bypasses and notify each stream.
 * Returns the list of streams that were previously bypassed.
 * @internal Called when the workspace feature is disabled.
 */
export function _disableAllProposalBypasses(): StreamTabId[] {
  const affected: StreamTabId[] = [];
  for (const [id, active] of bypassedByStream) {
    if (active) affected.push(id);
  }
  bypassedByStream.clear();
  for (const streamId of affected) {
    notifyBypassState(streamId);
  }
  return affected;
}
