/**
 * UI event handlers for retry and approval dialogs.
 *
 * These are callback-only handlers that simply delegate to UI callbacks
 * with error handling. Consolidated from RetryEvents.ts and ApprovalEvents.ts
 * to reduce module fragmentation.
 */

// Type imports
import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

// Local file imports
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'UIEvents';

/** Callbacks for retry event handling. */
export interface RetryCallbacks {
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  resolveRetryRequest: (streamId: string) => void;
}

/** Callbacks for approval event handling. */
export interface ApprovalCallbacks {
  showToolEditApprovalPrompt: (
    payload: ProgressEventPayloads['showToolEditApprovalPrompt'],
  ) => void;
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  updateToolEditApprovalBypassState: (
    streamId: string,
    bypassActive: boolean,
  ) => void;
}

/** Callbacks for agent proposal handling (workflow or tool-use). */
export interface AgentProposalCallbacks {
  showAgentProposal: (
    payload: ProgressEventPayloads['showAgentProposal'],
  ) => void;
  resolveAgentProposal: (proposalId: string) => void;
}

/** Combined UI callbacks interface. */
export type UICallbacks = RetryCallbacks &
  ApprovalCallbacks &
  AgentProposalCallbacks;

/** Helper to register an event with error handling wrapper. */
function registerEvent<K extends ProgressEvent>(
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
    'showToolEditApprovalPrompt',
    callbacks.showToolEditApprovalPrompt,
    'failed to show approval prompt',
    signal,
  );
  registerEvent(
    bus,
    'resolveToolEditApprovalPrompt',
    (p) => callbacks.resolveToolEditApprovalPrompt(p.requestId),
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
}
