/**
 * Session-scoped coordinator for workflow and tool-use agent proposals.
 */

import {
  toRuntimeHostProvider,
  type AgentRuntimeHost,
  type CoordinatorRuntimeHost,
  type RuntimeHostProvider,
} from '@agent/runtime/AgentRuntimeHost';
import type { AgentProposal } from '@shared/schemas';

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

export class AgentProposalCoordinator {
  private readonly getRuntimeHost: RuntimeHostProvider;
  private readonly proposalStreamMap = new Map<string, string>();

  constructor(runtimeHost: CoordinatorRuntimeHost) {
    this.getRuntimeHost = toRuntimeHostProvider(runtimeHost);
  }

  private get runtimeHost(): AgentRuntimeHost {
    return this.getRuntimeHost();
  }

  waitForProposal(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const { proposalId, proposal, timeoutMs } = options;
    if (this.proposalStreamMap.has(proposalId)) {
      this.clearRequest(proposalId);
    }
    this.proposalStreamMap.set(proposalId, streamId);

    this.runtimeHost.emit('requestEnsureProgressView', {});
    this.runtimeHost.emit('setActiveStream', { streamId });

    const interaction = this.runtimeHost.interactions?.requestAgentProposal?.(
      { proposalId, streamId, ...proposal },
      { timeoutMs },
    );
    if (!interaction) {
      this.proposalStreamMap.delete(proposalId);
      throw new Error('HostInteractions.requestAgentProposal is required');
    }

    return interaction.finally(() => this.proposalStreamMap.delete(proposalId));
  }

  clearRequest(proposalId: string): void {
    const streamId = this.proposalStreamMap.get(proposalId);
    this.proposalStreamMap.delete(proposalId);
    if (streamId) {
      const resolved =
        this.runtimeHost.interactions?.resolve(proposalId, {
          kind: 'proposal',
          action: 'reject',
        }) ?? false;
      if (!resolved) {
        this.runtimeHost.interactions?.cancelForStream(
          streamId,
          'Agent proposal cleared.',
        );
      }
    }
  }

  clearAll(): void {
    const proposalIds = [...this.proposalStreamMap.keys()];
    for (const proposalId of proposalIds) {
      this.clearRequest(proposalId);
    }
  }
}
