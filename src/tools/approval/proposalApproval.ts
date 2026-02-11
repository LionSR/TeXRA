/**
 * Per-stream bypass state for agent delegation proposals (Super YOLO mode).
 *
 * When both the workspace setting (SUPER_YOLO_ENABLED) and the per-stream
 * toggle are active, agent proposals are auto-approved without user interaction.
 */
import { WorkspaceStateKey, workspaceSM } from '@common/state';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

const proposalsBypassedByStream = new Map<StreamTabId, boolean>();

/** Check if the workspace-level Super YOLO feature is enabled. */
export function isSuperYoloFeatureEnabled(): boolean {
  return (
    workspaceSM.get<boolean>(WorkspaceStateKey.SUPER_YOLO_ENABLED, false) ??
    false
  );
}

function notifyProposalBypassState(streamId: StreamTabId): void {
  const bypassActive = proposalsBypassedByStream.get(streamId) ?? false;
  const featureEnabled = isSuperYoloFeatureEnabled();
  bus.emit('updateSuperYoloBypassState', {
    streamId,
    bypassActive,
    featureEnabled,
  });
}

/** Toggle per-stream proposal bypass. Returns new state. */
export function toggleProposalBypass(streamId: StreamTabId): boolean {
  const currentState = proposalsBypassedByStream.get(streamId) ?? false;
  const newState = !currentState;
  proposalsBypassedByStream.set(streamId, newState);
  notifyProposalBypassState(streamId);
  return newState;
}

/** Check if proposals are bypassed for a specific stream. */
export function isProposalBypassedForStream(streamId: StreamTabId): boolean {
  return proposalsBypassedByStream.get(streamId) ?? false;
}

/** @internal Called by unified cleanup in index.ts */
export function _clearProposalBypassForStream(streamId: StreamTabId): void {
  proposalsBypassedByStream.delete(streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _clearAllProposalBypass(): void {
  proposalsBypassedByStream.clear();
}

/**
 * Clear all per-stream proposal bypasses and notify each stream.
 * Returns the list of streams that were previously bypassed.
 * @internal Called when the workspace feature is disabled.
 */
export function _disableAllProposalBypasses(): StreamTabId[] {
  const affected: StreamTabId[] = [];
  for (const [id, active] of proposalsBypassedByStream) {
    if (active) affected.push(id);
  }
  proposalsBypassedByStream.clear();
  for (const streamId of affected) {
    notifyProposalBypassState(streamId);
  }
  return affected;
}
