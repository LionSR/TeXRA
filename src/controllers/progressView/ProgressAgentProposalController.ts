// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ProposalResult } from '@agent/runtime/HostInteractions';
import type { AgentProposal, AgentProposalPermission } from '@shared/schemas';
import type { ProgressAgentProposalActionMessage } from '@shared/schemas/progressView';
import { resolveWorkspaceRelativePath } from '@tools/pathResolution';
import { toErrorMessage } from '@utils/errors/errorMessage';

type WithoutCommand<Message> = Message extends unknown
  ? Omit<Message, 'command'>
  : never;
type AgentProposalActionInput =
  WithoutCommand<ProgressAgentProposalActionMessage>;

export interface ProgressAgentProposalControllerDeps {
  getPendingProposal(proposalId: string): AgentProposalPermission | undefined;
  restoreRunConfig(config: AgentConfig): Promise<boolean>;
  openFile(path: string): Promise<void>;
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
    const result = AgentConfigSchema.safeParse(proposal);
    if (!result.success) {
      this.deps.onInvalidProposal?.(result.error.issues);
      return false;
    }
    return this.deps.restoreRunConfig(result.data);
  }

  private async setupProposal(proposalId: string): Promise<boolean> {
    const proposal = this.deps.getPendingProposal(proposalId);
    if (!proposal) {
      this.deps.onMissingProposal?.(proposalId);
      return false;
    }

    if ('workflowScript' in proposal && proposal.workflowScript) {
      try {
        const scriptPath = resolveWorkspaceRelativePath(
          proposal.workflowScript.scriptPath,
          proposal.workingDirectory ?? undefined,
        );
        await this.deps.openFile(scriptPath.fsPath);
      } catch (error) {
        this.deps.settleProposal(proposalId, {
          action: 'reject',
          feedback: `Unable to open the workflow script for setup: ${toErrorMessage(error)}`,
        });
        return false;
      }
    } else {
      const restored = await this.restoreProposalConfig(proposal);
      if (!restored) {
        this.deps.settleProposal(proposalId, {
          action: 'reject',
          feedback: 'Unable to restore the proposal configuration for setup.',
        });
        return false;
      }
    }

    this.deps.settleProposal(proposalId, { action: 'setup' });
    this.deps.onSetupComplete?.(proposal);
    return true;
  }
}
