/**
 * UI event handlers for retry and approval dialogs.
 *
 * These are callback-only handlers that simply delegate to UI callbacks
 * with error handling. Consolidated from RetryEvents.ts and ApprovalEvents.ts
 * to reduce module fragmentation.
 */

// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { withEventErrorHandling } from './errorHandling';
import type { ProgressEventBusLike } from './types';

const MODULE = 'UIEvents';

/**
 * Callbacks for retry event handling.
 */
export interface RetryCallbacks {
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  resolveRetryRequest: (streamId: string) => void;
}

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
 * Combined UI callbacks interface.
 */
export type UICallbacks = RetryCallbacks & ApprovalCallbacks;

/**
 * Register all UI event handlers (retry and approval).
 * Cleanup is automatic via AbortSignal.
 */
export function registerUIEvents(
  bus: ProgressEventBusLike,
  callbacks: UICallbacks,
  signal: AbortSignal,
): void {
  // Retry events
  bus.on(
    'showRetryRequest',
    (payload) =>
      withEventErrorHandling(MODULE, 'failed to show retry request', () =>
        callbacks.showRetryRequest(payload),
      ),
    { signal },
  );

  bus.on(
    'resolveRetryRequest',
    (payload) =>
      withEventErrorHandling(MODULE, 'failed to resolve retry request', () =>
        callbacks.resolveRetryRequest(payload.streamId),
      ),
    { signal },
  );

  // Approval events
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
