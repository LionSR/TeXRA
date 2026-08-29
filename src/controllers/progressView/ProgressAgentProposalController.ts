// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ProposalResult } from '@agent/runtime/HostInteractions';
import type {
  AgentProposal,
  AgentProposalPermission,
  ProgressAgentProposalActionMessage,
} from '@shared/schemas';
import { resolveWorkspaceRelativePath } from '@tools/pathResolution';
import { toErrorMessage } from '@utils/errors/errorMessage';

type WithoutCommand<Message> = Message extends unknown
  ? Omit<Message, 'command'>
  : never;
type AgentProposalActionInput =
  WithoutCommand<ProgressAgentProposalActionMessage>;

export interface ProgressAgentProposalControllerDeps {
  getPendingProposal(requestId: string): AgentProposalPermission | undefined;
  restoreRunConfig(config: AgentConfig): Promise<boolean>;
  openFile(path: string): Promise<void>;
  settleProposal(requestId: string, result: ProposalResult): void;
  onMissingProposal?(requestId: string): void;
  onInvalidProposal?(issues: unknown): void;
  onSetupComplete?(proposal: AgentProposalPermission): void;
}

export class ProgressAgentProposalController {
  constructor(private readonly deps: ProgressAgentProposalControllerDeps) {}

  async handleAction(input: AgentProposalActionInput): Promise<void> {
    switch (input.action) {
      case 'setup':
        return this.setupProposal(input.requestId);
      case 'approve':
        this.deps.settleProposal(input.requestId, {
          action: 'approve',
          ...(input.model ? { model: input.model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
        });
        return;
      case 'reject':
        this.deps.settleProposal(input.requestId, {
          action: 'reject',
          ...(input.feedback ? { feedback: input.feedback } : {}),
        });
        return;
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

  private async setupProposal(requestId: string): Promise<void> {
    const proposal = this.deps.getPendingProposal(requestId);
    if (!proposal) {
      this.deps.onMissingProposal?.(requestId);
      return;
    }

    if ('workflowScript' in proposal && proposal.workflowScript) {
      try {
        const scriptPath = resolveWorkspaceRelativePath(
          proposal.workflowScript.scriptPath,
          proposal.workingDirectory ?? undefined,
        );
        await this.deps.openFile(scriptPath.fsPath);
      } catch (error) {
        this.deps.settleProposal(requestId, {
          action: 'reject',
          feedback: `Unable to open the workflow script for setup: ${toErrorMessage(error)}`,
        });
        return;
      }
    } else {
      const restored = await this.restoreProposalConfig(proposal);
      if (!restored) {
        this.deps.settleProposal(requestId, {
          action: 'reject',
          feedback: 'Unable to restore the proposal configuration for setup.',
        });
        return;
      }
    }

    this.deps.settleProposal(requestId, { action: 'setup' });
    this.deps.onSetupComplete?.(proposal);
  }
}
