/** Per-stream bypass state for agent delegation proposals. */
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

const bypassedByStream = new Map<StreamTabId, boolean>();

function notifyBypassState(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  runtimeHost.emit('updateSuperYoloBypassState', {
    streamId,
    bypassActive: bypassedByStream.get(streamId) ?? false,
  });
}

/** Toggle per-stream proposal bypass. Returns new state. */
export function toggleProposalBypass(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): boolean {
  const newState = !(bypassedByStream.get(streamId) ?? false);
  bypassedByStream.set(streamId, newState);
  notifyBypassState(streamId, runtimeHost);
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
