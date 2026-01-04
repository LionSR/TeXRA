// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type { ProgressEventBusLike } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'ApprovalEvents';

/**
 * Callbacks for approval event handling.
 */
export interface ApprovalCallbacks {
  showToolEditApprovalPrompt: (
    payload: ProgressEventPayloads['showToolEditApprovalPrompt'],
  ) => void;
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  updateToolEditApprovalBypassState: (bypassActive: boolean) => void;
}

/**
 * Register approval event handlers.
 * Cleanup is automatic via AbortSignal.
 */
export function registerApprovalEvents(
  bus: ProgressEventBusLike,
  callbacks: ApprovalCallbacks,
  signal: AbortSignal,
): void {
  bus.on(
    'showToolEditApprovalPrompt',
    (payload) =>
      withEventErrorHandling(MODULE, 'failed to show approval prompt', () =>
        callbacks.showToolEditApprovalPrompt(payload),
      ),
    { signal },
  );

  bus.on(
    'resolveToolEditApprovalPrompt',
    (payload) =>
      withEventErrorHandling(MODULE, 'failed to resolve approval prompt', () =>
        callbacks.resolveToolEditApprovalPrompt(payload.requestId),
      ),
    { signal },
  );

  bus.on(
    'updateToolEditApprovalBypassState',
    (payload) =>
      withEventErrorHandling(
        MODULE,
        'failed to update approval bypass state',
        () => callbacks.updateToolEditApprovalBypassState(payload.bypassActive),
      ),
    { signal },
  );
}
