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
import { BasePromiseCoordinator } from './BasePromiseCoordinator';

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
// Coordinator Implementation
// ============================================================================

/** Manages pending agent proposals (workflow and tool-use). */
class AgentProposalCoordinatorImpl extends BasePromiseCoordinator<
  ProposalResult,
  ProposalShowPayload
> {
  constructor() {
    super({
      showEventName: 'showAgentProposal',
      resolveEventName: 'resolveAgentProposal',
      idFieldName: 'proposalId',
      defaultCancelResult: { action: 'reject' },
    });
  }

  /** Wait for user action on a proposal. */
  waitForProposal(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const { proposalId, proposal, timeoutMs } = options;

    // Show progress view to ensure user sees the proposal
    void safeExecuteCommand('texra.showProgressView');

    return this.waitForUserAction(
      proposalId,
      { proposalId, streamId, ...proposal },
      { timeoutMs },
    );
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/** Singleton coordinator instance. */
export const proposalCoordinator = new AgentProposalCoordinatorImpl();
