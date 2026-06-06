/**
 * UI event handlers for retry and approval dialogs.
 *
 * These are callback-only handlers that simply delegate to UI callbacks
 * with error handling. Consolidated from RetryEvents.ts and ApprovalEvents.ts
 * to reduce module fragmentation.
 */

// Type imports
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

// Local file imports
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'UIEvents';

/** All UI callbacks for retry, approval, and proposal event handling. */
export interface UICallbacks {
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  resolveRetryRequest: (streamId: string) => void;
  showToolEditPermission: (
    payload: ProgressEventPayloads['showToolEditPermission'],
  ) => void;
  resolveToolEditPermission: (requestId: string) => void;
  updateToolEditApprovalBypassState: (
    streamId: string,
    bypassActive: boolean,
  ) => void;
  updateSuperYoloBypassState: (streamId: string, bypassActive: boolean) => void;
  showBashPermission: (
    payload: ProgressEventPayloads['showBashPermission'],
  ) => void;
  resolveBashPermission: (requestId: string) => void;
  showAgentProposal: (
    payload: ProgressEventPayloads['showAgentProposal'],
  ) => void;
  resolveAgentProposal: (proposalId: string) => void;
  showPlanApproval: (
    payload: ProgressEventPayloads['showPlanApproval'],
  ) => void;
  resolvePlanApproval: (approvalId: string) => void;
  showExternalInquiry: (
    payload: ProgressEventPayloads['showExternalInquiry'],
  ) => void;
  resolveExternalInquiry: (requestId: string) => void;
  showUserQuestion: (
    payload: ProgressEventPayloads['showUserQuestion'],
  ) => void;
  resolveUserQuestion: (requestId: string) => void;
}

/** Helper to register an event with error handling wrapper. */
function registerEvent<K extends keyof ProgressEventPayloads>(
  bus: ProgressEventBusLike,
  event: K,
  handler: (payload: ProgressEventPayloads[K]) => void,
  context: string,
  signal: AbortSignal,
): void {
  bus.on(
    event,
    (payload) =>
      withEventErrorHandling(MODULE, context, () => handler(payload)),
    { signal },
  );
}

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
  registerEvent(
    bus,
    'showRetryRequest',
    callbacks.showRetryRequest,
    'failed to show retry request',
    signal,
  );
  registerEvent(
    bus,
    'resolveRetryRequest',
    (p) => callbacks.resolveRetryRequest(p.streamId),
    'failed to resolve retry request',
    signal,
  );

  // Approval events
  registerEvent(
    bus,
    'showToolEditPermission',
    callbacks.showToolEditPermission,
    'failed to show approval prompt',
    signal,
  );
  registerEvent(
    bus,
    'resolveToolEditPermission',
    (p) => callbacks.resolveToolEditPermission(p.requestId),
    'failed to resolve approval prompt',
    signal,
  );
  registerEvent(
    bus,
    'updateToolEditApprovalBypassState',
    (p) =>
      callbacks.updateToolEditApprovalBypassState(p.streamId, p.bypassActive),
    'failed to update approval bypass state',
    signal,
  );

  // Super YOLO bypass state
  registerEvent(
    bus,
    'updateSuperYoloBypassState',
    (p) => callbacks.updateSuperYoloBypassState(p.streamId, p.bypassActive),
    'failed to update super yolo bypass state',
    signal,
  );

  // Bash approval events
  registerEvent(
    bus,
    'showBashPermission',
    callbacks.showBashPermission,
    'failed to show bash approval prompt',
    signal,
  );
  registerEvent(
    bus,
    'resolveBashPermission',
    (p) => callbacks.resolveBashPermission(p.requestId),
    'failed to resolve bash approval prompt',
    signal,
  );

  // Agent proposal events (workflow or tool-use)
  registerEvent(
    bus,
    'showAgentProposal',
    callbacks.showAgentProposal,
    'failed to show agent proposal',
    signal,
  );
  registerEvent(
    bus,
    'resolveAgentProposal',
    (p) => callbacks.resolveAgentProposal(p.proposalId),
    'failed to resolve agent proposal',
    signal,
  );

  // Plan approval events
  registerEvent(
    bus,
    'showPlanApproval',
    callbacks.showPlanApproval,
    'failed to show plan approval',
    signal,
  );
  registerEvent(
    bus,
    'resolvePlanApproval',
    (p) => callbacks.resolvePlanApproval(p.approvalId),
    'failed to resolve plan approval',
    signal,
  );

  // External inquiry events
  registerEvent(
    bus,
    'showExternalInquiry',
    callbacks.showExternalInquiry,
    'failed to show external inquiry',
    signal,
  );
  registerEvent(
    bus,
    'resolveExternalInquiry',
    (p) => callbacks.resolveExternalInquiry(p.requestId),
    'failed to resolve external inquiry',
    signal,
  );

  // User question events
  registerEvent(
    bus,
    'showUserQuestion',
    callbacks.showUserQuestion,
    'failed to show user question',
    signal,
  );
  registerEvent(
    bus,
    'resolveUserQuestion',
    (p) => callbacks.resolveUserQuestion(p.requestId),
    'failed to resolve user question',
    signal,
  );
}
