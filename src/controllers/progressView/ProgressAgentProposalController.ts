// Local imports - agent
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ProposalResult } from '@agent/runtime/HostInteractions';

import type { TaskState } from '@agent/core/state/TaskState';
import type { AgentProposal, AgentProposalPermission } from '@shared/schemas';
import type { ProgressAgentProposalActionMessage } from '@shared/schemas/progressView';

// Local imports - shared

type WithoutCommand<Message> = Message extends unknown
  ? Omit<Message, 'command'>
  : never;
type AgentProposalActionInput =
  WithoutCommand<ProgressAgentProposalActionMessage>;

export interface ProgressAgentProposalControllerDeps {
  getPendingProposal(proposalId: string): AgentProposalPermission | undefined;
  restoreTaskState(taskState: TaskState): Promise<boolean>;
  settleProposal(proposalId: string, result: ProposalResult): void;
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
        this.deps.settleProposal(input.proposalId, {
          action: 'approve',
          ...(input.model ? { model: input.model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
        });
        return true;
      case 'reject':
        this.deps.settleProposal(input.proposalId, {
          action: 'reject',
          ...(input.feedback ? { feedback: input.feedback } : {}),
        });
        return true;
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
      this.deps.settleProposal(proposalId, {
        action: 'reject',
        feedback: 'Unable to restore the proposal configuration for setup.',
      });
      return false;
    }

    this.deps.settleProposal(proposalId, { action: 'setup' });
    this.deps.onSetupComplete?.(proposal);
    return true;
  }

  private buildTaskState(proposal: AgentProposal): TaskState | null {
    const result = AgentConfigSchema.safeParse(proposal);

    if (!result.success) {
      this.deps.onInvalidProposal?.(result.error.issues);
      return null;
    }

    if (result.data.agentCategory === AgentCategory.Workflow) {
      return {
        agentConfig: result.data,
        activeFiles: {
          input: result.data.inputFiles.length > 0,
          context: result.data.contextFiles.length > 0,
          media: result.data.mediaFiles.length > 0,
          output: result.data.outputFiles.length > 0,
        },
      };
    }
    return { agentConfig: result.data };
  }
}
