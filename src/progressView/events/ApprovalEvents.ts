// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import {
  createEventDisposable,
  type EventModuleBase,
  type ProgressEventBusLike,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'ApprovalEvents';

/**
 * Callbacks for approval event handling.
 */
export interface ApprovalEventsShared {
  showToolEditApprovalPrompt: (
    payload: ProgressEventPayloads['showToolEditApprovalPrompt'],
  ) => void;
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  updateToolEditApprovalBypassState: (bypassActive: boolean) => void;
}

export type ApprovalEventsModule = EventModuleBase;

/**
 * Create approval event module for registration.
 */
export function createApprovalEvents(
  callbacks: ApprovalEventsShared,
): ApprovalEventsModule {
  return {
    register(bus) {
      return [
        createEventDisposable(bus, 'showToolEditApprovalPrompt', (payload) =>
          withEventErrorHandling(MODULE, 'failed to show approval prompt', () =>
            callbacks.showToolEditApprovalPrompt(payload),
          ),
        ),
        createEventDisposable(bus, 'resolveToolEditApprovalPrompt', (payload) =>
          withEventErrorHandling(
            MODULE,
            'failed to resolve approval prompt',
            () => callbacks.resolveToolEditApprovalPrompt(payload.requestId),
          ),
        ),
        createEventDisposable(
          bus,
          'updateToolEditApprovalBypassState',
          (payload) =>
            withEventErrorHandling(
              MODULE,
              'failed to update approval bypass state',
              () =>
                callbacks.updateToolEditApprovalBypassState(
                  payload.bypassActive,
                ),
            ),
        ),
      ];
    },
  };
}
