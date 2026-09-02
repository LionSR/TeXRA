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

/**
 * The host-specific half of the agent-proposal wiring: where a pending
 * proposal is found, how a config is restored into the main view, how a file
 * is opened, which interaction registry settles the decision, and where to
 * report. `log` is structural so the extension's `Log` and the desktop's
 * `AgentTrace` both satisfy it without either host adapting its logger.
 */
export interface ProgressAgentProposalHostPort {
  getPendingProposal(requestId: string): AgentProposalPermission | undefined;
  restoreRunConfig(config: AgentConfig): Promise<boolean>;
  openFile(path: string): Promise<void>;
  /** False when no pending host interaction matched `requestId`. */
  submitProposalDecision(requestId: string, result: ProposalResult): boolean;
  log: {
    info(message: string, options?: { data?: unknown }): void;
    warn(message: string, options?: { data?: unknown }): void;
  };
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

/**
 * Builds the controller with the diagnostics both hosts had written out
 * separately. The three `on*` hooks and the "nothing was pending" arm of
 * `settleProposal` carry no host-specific behavior — only the log channel
 * differs, and each host's logger already names itself — so they belong here
 * rather than in two copies that drift apart.
 */
export function createProgressAgentProposalController(
  port: ProgressAgentProposalHostPort,
): ProgressAgentProposalController {
  const { log } = port;
  return new ProgressAgentProposalController({
    getPendingProposal: port.getPendingProposal,
    restoreRunConfig: port.restoreRunConfig,
    openFile: port.openFile,
    settleProposal: (requestId, result) => {
      if (port.submitProposalDecision(requestId, result)) return;
      log.warn(`No pending host interaction found for proposal: ${requestId}`);
    },
    onMissingProposal: (requestId) => {
      log.warn(`No pending agent proposal found for setup: ${requestId}`);
    },
    onInvalidProposal: (issues) => {
      log.warn('Invalid proposal config', { data: { errors: issues } });
    },
    onSetupComplete: (proposal) => {
      log.info(`Agent proposal ${proposal.requestId} set up in main view`, {
        data: { agent: proposal.agent },
      });
    },
  });
}
