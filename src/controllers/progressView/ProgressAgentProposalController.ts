// Local imports - agent
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ProposalResult } from '@agent/runtime/AgentProposalCoordinator';

// Local imports - logger
import type { TaskState } from '@logger/TaskState';

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
  resolveProposal(proposalId: string, result: ProposalResult): void;
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

  private buildTaskState(proposal: AgentProposal): TaskState | null {
    const isWorkflow = proposal.agentCategory === AgentCategory.Workflow;
    const activeFiles =
      proposal.agentCategory === AgentCategory.Workflow
        ? {
            input: proposal.inputFiles.length > 0,
            context: proposal.contextFiles.length > 0,
            media: proposal.mediaFiles.length > 0,
            output: proposal.outputFiles.length > 0,
          }
        : {
            input: false,
            context: false,
            media: false,
            output: false,
          };

    const result = AgentConfigSchema.safeParse({
      ...proposal,
      ...(isWorkflow && {
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
      isWorkflow
        ? { agentConfig: result.data, activeFiles }
        : { agentConfig: result.data }
    ) as TaskState & { agentConfig: AgentConfig };
  }
}
