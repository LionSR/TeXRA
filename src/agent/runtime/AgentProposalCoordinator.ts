/**
 * Promise-based coordinator for agent proposals (workflow and tool-use).
 *
 * Handles both:
 * - Workflow agents (document processing with file I/O)
 * - Tool-use agents (interactive assistants with tools)
 *
 * Flow:
 * 1. Tool calls `waitForProposal()` - returns Promise, emits 'showAgentProposal'
 * 2. User approves/rejects/sets up → resolves Promise with corresponding action
 * 3. On resolution → emits 'resolveAgentProposal' to dismiss UI
 */

// Local imports
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import type { AgentProposal } from '@eventBus/types';
import { PromiseCoordinator } from './BasePromiseCoordinator';

// ============================================================================
// Types
// ============================================================================

/** Result of an agent proposal (workflow or tool-use). */
export type ProposalResult =
  | { action: 'approve' }
  | { action: 'reject'; feedback?: string }
  | { action: 'setup' }
  | { action: 'timeout' };

export interface ProposalRequestOptions {
  proposalId: string;
  proposal: AgentProposal;
  /** Timeout in milliseconds (default: wait indefinitely) */
  timeoutMs?: number;
}

/** Payload for show event */
interface ProposalShowPayload {
  proposalId: string;
  streamId: string;
  [key: string]: unknown; // Spread from proposal
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create the proposal coordinator with its specialized API.
 * Uses factory function + composition instead of class inheritance
 * since only the config and one wrapper method are needed.
 */
function createProposalCoordinator() {
  const coordinator = new PromiseCoordinator<ProposalResult, ProposalShowPayload>({
    showEventName: 'showAgentProposal',
    resolveEventName: 'resolveAgentProposal',
    idFieldName: 'proposalId',
    defaultCancelResult: { action: 'reject' },
  });

  return {
    /** Wait for user action on a proposal. */
    waitForProposal(
      streamId: string,
      options: ProposalRequestOptions,
    ): Promise<ProposalResult> {
      const { proposalId, proposal, timeoutMs } = options;

      // Show progress view to ensure user sees the proposal
      void safeExecuteCommand('texra.showProgressView');

      return coordinator.waitForUserAction(
        proposalId,
        { proposalId, streamId, ...proposal },
        { timeoutMs },
      );
    },

    /** Check if a proposal is pending. */
    hasPendingRequest(proposalId: string): boolean {
      return coordinator.hasPendingRequest(proposalId);
    },

    /** Resolve a pending proposal. */
    resolveRequest(proposalId: string, result: ProposalResult): boolean {
      return coordinator.resolveRequest(proposalId, result);
    },

    /** Clear a pending proposal without user action. */
    clearRequest(proposalId: string): void {
      coordinator.clearRequest(proposalId);
    },
  };
}

// ============================================================================
// Singleton Export
// ============================================================================

/** Singleton coordinator instance. */
export const proposalCoordinator = createProposalCoordinator();
