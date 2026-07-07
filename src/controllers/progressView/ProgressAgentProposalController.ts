// Local imports - agent
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ProposalResult } from '@agent/runtime/HostInteractions';

import type { TaskState } from '@agent/core/state/TaskState';

// Local imports - shared
import type { AgentProposal, AgentProposalPermission } from '@shared/schemas';
import type { ProgressAgentProposalActionMessage } from '@shared/schemas/progressView';

type AgentProposalActionInput = Omit<
  ProgressAgentProposalActionMessage,
  'command'
>;

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
    const isWorkflow = proposal.agentCategory === AgentCategory.Workflow;
    const activeFiles = isWorkflow
      ? {
          input: proposal.inputFiles.length > 0,
          context: proposal.contextFiles.length > 0,
          media: proposal.mediaFiles.length > 0,
          output: proposal.outputFiles.length > 0,
        }
      : undefined;

    const result = AgentConfigSchema.safeParse({
      ...proposal,
      ...(activeFiles && {
        inputFilesActive: activeFiles.input,
        contextFilesActive: activeFiles.context,
        mediaFilesActive: activeFiles.media,
        outputFilesActive: activeFiles.output,
      }),
    });

    if (!result.success) {
      this.deps.onInvalidProposal?.(result.error.issues);
      return null;
    }

    return (
      activeFiles
        ? { agentConfig: result.data, activeFiles }
        : { agentConfig: result.data }
    ) as TaskState & { agentConfig: AgentConfig };
  }
}
