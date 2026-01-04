// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type {
  BaseEventShared,
  EventModuleBase,
  ProgressEventBusLike,
} from './types';

/**
 * Shared context for ApprovalEvents module.
 * Extends BaseEventShared with approval-specific callbacks.
 */
export interface ApprovalEventsShared extends BaseEventShared {
  showToolEditApprovalPrompt: (
    payload: ProgressEventPayloads['showToolEditApprovalPrompt'],
  ) => void;
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  updateToolEditApprovalBypassState: (bypassActive: boolean) => void;
}

/**
 * ApprovalEvents module interface.
 * Uses EventModuleBase pattern (bus only, no state/updater).
 */
export type ApprovalEventsModule = EventModuleBase;

/**
 * Creates a module for handling tool edit approval events.
 * Follows the established event module pattern used by RetryEvents.
 */
export function createApprovalEvents(
  shared: ApprovalEventsShared,
): ApprovalEventsModule {
  const { withErrorBoundary } = shared;

  return {
    register(bus: ProgressEventBusLike): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('showToolEditApprovalPrompt', (payload) =>
            withErrorBoundary('failed to show approval prompt', () =>
              shared.showToolEditApprovalPrompt(payload),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('resolveToolEditApprovalPrompt', (payload) =>
            withErrorBoundary('failed to resolve approval prompt', () =>
              shared.resolveToolEditApprovalPrompt(payload.requestId),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('updateToolEditApprovalBypassState', (payload) =>
            withErrorBoundary('failed to update approval bypass state', () =>
              shared.updateToolEditApprovalBypassState(payload.bypassActive),
            ),
          ),
        ),
      ];
    },
  };
}
