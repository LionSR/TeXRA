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

import { getDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { AgentProposal } from '@shared/schemas';
import {
  BasePromiseCoordinator,
  type CoordinatorConfig,
} from './BasePromiseCoordinator';

// ============================================================================
// Types
// ============================================================================

/** Result of an agent proposal (workflow or tool-use). */
export type ProposalResult =
  | { action: 'approve'; model?: string; agent?: string }
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
interface ProposalShowPayload extends Record<string, unknown> {
  proposalId: string;
  streamId: string;
}

// ============================================================================
// Coordinator Implementation
// ============================================================================

/** Manages pending agent proposals (workflow and tool-use). */
export class AgentProposalCoordinator extends BasePromiseCoordinator<
  ProposalResult,
  ProposalShowPayload
> {
  protected readonly config: CoordinatorConfig = {
    showEventName: 'showAgentProposal',
    resolveEventName: 'resolveAgentProposal',
    idFieldName: 'proposalId',
  };

  protected getDefaultCancelResult(): ProposalResult {
    return { action: 'reject' };
  }

  /** Wait for user action on a proposal. Uses different signature from base class. */
  waitForProposal(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const { proposalId, proposal, timeoutMs } = options;

    // Request host to show progress view so user sees the proposal
    this.runtimeHost.emit('requestEnsureProgressView', {});

    // Activate the stream that needs approval so user sees the prompt immediately
    this.runtimeHost.emit('setActiveStream', { streamId });

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
export const proposalCoordinator = new AgentProposalCoordinator(
  getDefaultAgentRuntimeHost,
);
