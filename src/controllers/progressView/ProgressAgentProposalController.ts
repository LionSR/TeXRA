// Local imports - agent
import { buildRuntimeTaskStateFromConfigInput } from '@agent/runtime/executionRequests';
import type { RuntimeTaskState } from '@agent/runtime/executionRequests';
import type { RuntimeProposalResult } from '@agent/runtime/runCoordinatorCommands';

// Local imports - shared
import type { AgentProposal, AgentProposalPermission } from '@shared/schemas';
import type { ProgressAgentProposalActionMessage } from '@shared/schemas/progressView';

type AgentProposalActionInput = Omit<
  ProgressAgentProposalActionMessage,
  'command'
>;

export interface ProgressAgentProposalControllerDeps {
  getPendingProposal(proposalId: string): AgentProposalPermission | undefined;
  restoreTaskState(taskState: RuntimeTaskState): Promise<boolean>;
  resolveProposal(proposalId: string, result: RuntimeProposalResult): void;
  onMissingProposal?(proposalId: string): void;
  onInvalidProposal?(issues: unknown): void;
  onSetupComplete?(proposal: AgentProposalPermission): void;
}

export class ProgressAgentProposalController {
  constructor(private readonly deps: ProgressAgentProposalControllerDeps) {}

  async handleAction(input: AgentProposalActionInput): Promise<boolean> {
    switch (input.action) {
      case 'setup':
        return this.setupProposal(input.proposalId);
      case 'approve':
        this.deps.resolveProposal(input.proposalId, {
          action: 'approve',
          model: input.model,
          agent: input.agent,
        });
        return true;
      case 'reject':
        this.deps.resolveProposal(input.proposalId, {
          action: 'reject',
          feedback: input.feedback,
        });
        return true;
      default:
        return false;
    }
  }

  async restoreProposalConfig(proposal: AgentProposal): Promise<boolean> {
    const taskState = this.buildTaskState(proposal);
    if (!taskState) return false;
    return this.deps.restoreTaskState(taskState);
  }

  private async setupProposal(proposalId: string): Promise<boolean> {
    const proposal = this.deps.getPendingProposal(proposalId);
    if (!proposal) {
      this.deps.onMissingProposal?.(proposalId);
      return false;
    }

    const restored = await this.restoreProposalConfig(proposal);
    if (!restored) {
      this.deps.resolveProposal(proposalId, {
        action: 'reject',
        feedback: 'Unable to restore the proposal configuration for setup.',
      });
      return false;
    }

    this.deps.resolveProposal(proposalId, { action: 'setup' });
    this.deps.onSetupComplete?.(proposal);
    return true;
  }

  private buildTaskState(proposal: AgentProposal): RuntimeTaskState | null {
    const result = buildRuntimeTaskStateFromConfigInput(proposal);

    if (!result.success) {
      this.deps.onInvalidProposal?.(result.issues);
      return null;
    }

    return result.taskState;
  }
}
