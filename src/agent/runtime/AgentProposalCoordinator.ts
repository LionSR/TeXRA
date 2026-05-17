/**
 * Promise-based coordinator for workflow and tool-use agent proposals.
 *
 * 1. Tool calls `waitForProposal()` → returns Promise, emits 'showAgentProposal'.
 * 2. User approves/rejects/sets up → resolves Promise with the corresponding action.
 * 3. On resolution → emits 'resolveAgentProposal' to dismiss UI.
 */

import { getDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { AgentProposal } from '@shared/schemas';
import {
  BasePromiseCoordinator,
  type CoordinatorConfig,
} from './BasePromiseCoordinator';

export type ProposalResult =
  | { action: 'approve'; model?: string; agent?: string }
  | { action: 'reject'; feedback?: string }
  | { action: 'setup' }
  | { action: 'timeout' };

export interface ProposalRequestOptions {
  proposalId: string;
  proposal: AgentProposal;
  /** Timeout in milliseconds (default: wait indefinitely). */
  timeoutMs?: number;
}

interface ProposalShowPayload extends Record<string, unknown> {
  proposalId: string;
  streamId: string;
}

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

  waitForProposal(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const { proposalId, proposal, timeoutMs } = options;

    this.runtimeHost.emit('requestEnsureProgressView', {});
    this.runtimeHost.emit('setActiveStream', { streamId });

    return this.waitForUserAction(
      proposalId,
      { proposalId, streamId, ...proposal },
      { timeoutMs },
    );
  }
}

export const proposalCoordinator = new AgentProposalCoordinator(
  getDefaultAgentRuntimeHost,
);
