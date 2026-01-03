// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import {
  registerSimpleEvents,
  type BaseEventShared,
  type EventModuleBase,
  type ProgressEventBusLike,
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
export function createApprovalEventsModule(
  shared: ApprovalEventsShared,
): ApprovalEventsModule {
  const { withErrorBoundary } = shared;

  return {
    register(bus) {
      return registerSimpleEvents(bus, withErrorBoundary, [
        {
          event: 'showToolEditApprovalPrompt',
          errorMessage: 'failed to show approval prompt',
          handler: shared.showToolEditApprovalPrompt,
        },
        {
          event: 'resolveToolEditApprovalPrompt',
          errorMessage: 'failed to resolve approval prompt',
          handler: (payload) =>
            shared.resolveToolEditApprovalPrompt(payload.requestId),
        },
        {
          event: 'updateToolEditApprovalBypassState',
          errorMessage: 'failed to update approval bypass state',
          handler: (payload) =>
            shared.updateToolEditApprovalBypassState(payload.bypassActive),
        },
      ]);
    },
  };
}
