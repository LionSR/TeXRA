/**
 * WorkflowAgentProposalCoordinator - Promise-based coordinator for workflow agent proposals.
 *
 * Enables tool-use agents to propose workflow agent executions that require user review.
 * The coordinator manages the lifecycle of proposals shown in the ProgressBoard.
 *
 * Architecture:
 * - Single source of truth: One Map tracks all pending proposals
 * - Promise-based: Tools await a Promise that resolves when user acts
 * - Two states: pending (waiting for user) and resolved (done)
 *
 * Flow:
 * 1. Tool calls `waitForUserAction()` - returns Promise, emits 'showWorkflowAgentProposal'
 * 2. User clicks approve → `approveProposal()` → resolves Promise with 'approve'
 * 3. Or: User rejects → `rejectProposal()` → resolves Promise with 'reject'
 * 4. Or: Timeout → auto-resolves Promise with 'timeout'
 * 5. On resolution → emits 'resolveWorkflowAgentProposal' to dismiss UI
 */

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import type { WorkflowAgentProposal } from '@eventBus/types';
import { safeExecuteCommand } from '@frontend/system/commandUtils';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a workflow agent proposal. Discriminated union for type-safe handling.
 */
export type ProposalResult =
  | { action: 'approve' }
  | { action: 'reject'; feedback?: string }
  | { action: 'setup' }
  | { action: 'timeout' };

/**
 * Options for initiating a workflow agent proposal.
 */
export interface ProposalRequestOptions {
  /** Unique identifier for this proposal */
  proposalId: string;
  /** The workflow agent proposal details */
  proposal: WorkflowAgentProposal;
  /** Timeout in milliseconds (defaults to no timeout - wait indefinitely) */
  timeoutMs?: number;
}

/**
 * Internal state for a proposal request.
 * Only two states: pending (waiting for user action) or resolved (done).
 */
type ProposalRequestState =
  | {
      status: 'pending';
      resolve: (result: ProposalResult) => void;
      timeoutId?: NodeJS.Timeout;
      proposalId: string;
    }
  | { status: 'resolved' };

// ============================================================================
// Coordinator Implementation
// ============================================================================

/**
 * Manages pending workflow agent proposals.
 * This is a singleton module-level coordinator.
 */
class WorkflowAgentProposalCoordinatorImpl {
  /** Single source of truth for all pending proposals */
  private readonly proposals = new Map<string, ProposalRequestState>();

  /**
   * Wait for user action on a workflow agent proposal.
   * The Promise resolves when the user clicks approve, reject, or timeout occurs.
   *
   * @param streamId - Unique identifier for the stream
   * @param options - Proposal options including the proposal details
   * @returns Promise that resolves with the user's action
   */
  waitForUserAction(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const { proposalId, proposal, timeoutMs } = options;

    // If there's an existing pending proposal for this ID, cancel it first.
    const existingProposal = this.proposals.get(proposalId);
    if (existingProposal?.status === 'pending') {
      clearTimeout(existingProposal.timeoutId);
      existingProposal.resolve({ action: 'reject' });
    }

    return new Promise<ProposalResult>((resolve) => {
      // Only set timeout if explicitly requested (wait indefinitely by default)
      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          const req = this.proposals.get(proposalId);
          if (req?.status === 'pending' && req.resolve === resolve) {
            this.resolveProposal(proposalId, { action: 'timeout' });
          }
        }, timeoutMs);
      }

      // Store pending state
      this.proposals.set(proposalId, {
        status: 'pending',
        resolve,
        timeoutId,
        proposalId,
      });

      // Ensure progress view is visible and emit event to show proposal in UI
      void safeExecuteCommand('texra.showProgressView');
      bus.emit('showWorkflowAgentProposal', {
        proposalId,
        streamId,
        ...proposal,
      });
    });
  }

  /**
   * Handle a user action (approve or reject) for a pending proposal.
   * @returns true if the action was handled, false if no pending proposal
   */
  private handleUserAction(
    proposalId: string,
    action: 'approve' | 'reject',
  ): boolean {
    const req = this.getPendingProposal(proposalId);
    if (!req) return false;

    this.resolveProposal(proposalId, { action });
    return true;
  }

  /**
   * Approve a workflow agent proposal. Called when user clicks the approve button.
   * Resolves the pending Promise with 'approve' action.
   *
   * @param proposalId - The proposal to approve
   * @returns true if approved, false if no pending proposal
   */
  approveProposal(proposalId: string): boolean {
    return this.handleUserAction(proposalId, 'approve');
  }

  /**
   * Reject a workflow agent proposal. Called when user clicks the reject button.
   * Resolves the pending Promise with 'reject' action and optional feedback.
   *
   * @param proposalId - The proposal to reject
   * @param feedback - Optional feedback from the user explaining the rejection
   * @returns true if rejected, false if no pending proposal
   */
  rejectProposal(proposalId: string, feedback?: string): boolean {
    const req = this.getPendingProposal(proposalId);
    if (!req) return false;

    this.resolveProposal(proposalId, { action: 'reject', feedback });
    return true;
  }

  /**
   * Setup a workflow agent proposal. Called when user clicks the setup button.
   * Resolves the pending Promise with 'setup' action, indicating user wants to
   * edit the proposal in the main view before execution.
   *
   * @param proposalId - The proposal to setup
   * @returns true if setup initiated, false if no pending proposal
   */
  setupProposal(proposalId: string): boolean {
    const req = this.getPendingProposal(proposalId);
    if (!req) return false;

    this.resolveProposal(proposalId, { action: 'setup' });
    return true;
  }

  /**
   * Check if a proposal is pending.
   */
  hasPendingProposal(proposalId: string): boolean {
    return this.getPendingProposal(proposalId) !== null;
  }

  /**
   * Clear a pending proposal without resolving it.
   * Used for cleanup when the flow is cancelled externally.
   *
   * @param proposalId - The proposal to clear
   */
  clearProposal(proposalId: string): void {
    const req = this.getPendingProposal(proposalId);
    if (!req) return;

    clearTimeout(req.timeoutId);
    // Resolve with reject to avoid hanging Promise and potential memory leak
    req.resolve({ action: 'reject' });
    this.cleanup(proposalId);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Get a pending proposal if it exists, or null otherwise.
   * Type-safe accessor that narrows the discriminated union.
   */
  private getPendingProposal(
    proposalId: string,
  ): (ProposalRequestState & { status: 'pending' }) | null {
    const req = this.proposals.get(proposalId);
    return req?.status === 'pending' ? req : null;
  }

  /**
   * Resolve a pending proposal and clean up.
   */
  private resolveProposal(proposalId: string, result: ProposalResult): void {
    const req = this.getPendingProposal(proposalId);
    if (!req) return;

    clearTimeout(req.timeoutId);
    req.resolve(result);
    this.cleanup(proposalId);
  }

  /**
   * Clean up state and emit UI resolution event.
   */
  private cleanup(proposalId: string): void {
    this.proposals.set(proposalId, { status: 'resolved' });

    // Emit UI event synchronously so UI updates immediately
    bus.emit('resolveWorkflowAgentProposal', { proposalId });

    // Defer Map deletion to avoid blocking current execution
    setImmediate(() => {
      // Only delete if still resolved (not replaced by a new request)
      const req = this.proposals.get(proposalId);
      if (req?.status === 'resolved') {
        this.proposals.delete(proposalId);
      }
    });
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton coordinator instance.
 * This is a module-level singleton, matching the pattern of RetryRequestCoordinator.
 */
export const proposalCoordinator = new WorkflowAgentProposalCoordinatorImpl();
