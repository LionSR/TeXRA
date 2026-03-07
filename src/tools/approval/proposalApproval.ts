/**
 * Per-stream bypass state for agent delegation proposals (Super YOLO mode).
 *
 * When both the workspace setting (SUPER_YOLO_ENABLED) and the per-stream
 * toggle are active, agent proposals are auto-approved without user interaction.
 */
import { WorkspaceStateKey, workspaceSM } from '@common/state';
import type { StreamTabId } from '@shared/schemas';
import { BypassStateManager } from './BypassStateManager';

/** Check if the workspace-level Super YOLO feature is enabled. */
export function isSuperYoloFeatureEnabled(): boolean {
  return (
    workspaceSM.get<boolean>(WorkspaceStateKey.SUPER_YOLO_ENABLED, false) ??
    false
  );
}

const proposalBypass = new BypassStateManager(
  'updateSuperYoloBypassState',
  (streamId, bypassActive) => ({
    streamId,
    bypassActive,
    featureEnabled: isSuperYoloFeatureEnabled(),
  }),
);

/** Toggle per-stream proposal bypass. Returns new state. */
export function toggleProposalBypass(streamId: StreamTabId): boolean {
  return proposalBypass.toggle(streamId);
}

/** Check if proposals are bypassed for a specific stream. */
export function isProposalBypassedForStream(streamId: StreamTabId): boolean {
  return proposalBypass.isActive(streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _clearProposalBypassForStream(streamId: StreamTabId): void {
  proposalBypass.clearForStream(streamId);
}

/** @internal Called by unified cleanup in index.ts */
export function _clearAllProposalBypass(): void {
  proposalBypass.clearAll();
}

/**
 * Clear all per-stream proposal bypasses and notify each stream.
 * Returns the list of streams that were previously bypassed.
 * @internal Called when the workspace feature is disabled.
 */
export function _disableAllProposalBypasses(): StreamTabId[] {
  return proposalBypass.disableAllAndNotify();
}
