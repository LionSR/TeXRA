// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import { platform } from '@platform/platform';
import type { RunIdentity, StreamTabId } from '@shared/schemas';

// Local file imports
import {
  createProgressViewCommandHandlers,
  type ProgressViewApprovalCommandActions,
  type ProgressViewBypassCommandOptions,
  type ProgressViewExternalInquiryCommandActions,
  type ProgressViewFileCommandActions,
  type ProgressViewFollowUpCommandActions,
  type ProgressViewLifecycleCommandActions,
} from './ProgressViewCommandHandlers';
import {
  ProgressAgentProposalController,
  type ProgressAgentProposalControllerDeps,
} from './ProgressAgentProposalController';
import {
  ProgressWorkflowFileActionsController,
  type ProgressWorkflowFileActionsControllerDeps,
} from './ProgressWorkflowFileActionsController';

type ProgressViewFileHostActions = Pick<
  ProgressViewFileCommandActions,
  'openFile' | 'openFileCompile'
>;

type ProgressViewApprovalHostActions = Omit<
  ProgressViewApprovalCommandActions,
  'handleAgentProposalAction'
>;

interface ProgressViewHostCommandOptions {
  readonly lifecycle: ProgressViewLifecycleCommandActions;
  readonly followUp: ProgressViewFollowUpCommandActions;
  readonly bypass: ProgressViewBypassCommandOptions;
  readonly file: ProgressViewFileHostActions;
  readonly approval: ProgressViewApprovalHostActions;
  readonly externalInquiry: ProgressViewExternalInquiryCommandActions;
}

interface ProgressViewRunState {
  getRunConfig(stream: StreamTabId): AgentConfig | undefined;
  getRunIdentity(stream: StreamTabId): RunIdentity | undefined;
  getExecutionId(stream: StreamTabId): string | undefined;
}

/**
 * Resume, rerun, and restore are native-agent affordances. A workflow-script
 * stream's persisted config is a borrowed default agent, a process stream's is
 * synthetic, and an external-CLI session resumes through its own tool — for
 * all three, relaunching the stored config would run the wrong thing
 * (live defect 3 of the run-classification consolidation).
 */
function isNativeAgentRun(identity: RunIdentity | undefined): boolean {
  return identity?.kind === 'agent' && identity.tool === undefined;
}

interface ProgressViewRunDependencies {
  readonly state: ProgressViewRunState;
  executeAgent(request: ExecutionRequest): Promise<void>;
}

/**
 * Resume the run behind a stream. Workflow runs relaunch through the host's
 * executor with the original execution id; tool-use runs carry canonical
 * session state, so they go through the host resume port that restores it
 * instead of starting a fresh run.
 */
async function resumeStream(
  dependencies: ProgressViewRunDependencies,
  stream: StreamTabId,
): Promise<void> {
  if (!isNativeAgentRun(dependencies.state.getRunIdentity(stream))) return;
  const config = dependencies.state.getRunConfig(stream);
  if (!config) return;

  if (config.agentCategory !== AgentCategory.Workflow) {
    await platform().agentResume.tryResumeStream(stream);
    return;
  }

  const executionId = dependencies.state.getExecutionId(stream);
  await dependencies.executeAgent({
    config,
    ...(executionId && { executionId }),
  });
}

async function runNewStream(
  dependencies: ProgressViewRunDependencies,
  stream: StreamTabId,
): Promise<void> {
  if (!isNativeAgentRun(dependencies.state.getRunIdentity(stream))) return;
  const config = dependencies.state.getRunConfig(stream);
  if (!config) return;

  await dependencies.executeAgent({ config });
}

export interface ProgressViewHostOptions {
  readonly run: ProgressViewRunDependencies;
  readonly workflowFileActions: ProgressWorkflowFileActionsControllerDeps;
  readonly agentProposal: ProgressAgentProposalControllerDeps;
  readonly commands: ProgressViewHostCommandOptions;
}

export class ProgressViewHost {
  readonly workflowFileActionsController: ProgressWorkflowFileActionsController;
  readonly agentProposalController: ProgressAgentProposalController;
  readonly commandHandlers: ReturnType<
    typeof createProgressViewCommandHandlers
  >;

  constructor(options: ProgressViewHostOptions) {
    this.workflowFileActionsController =
      new ProgressWorkflowFileActionsController(options.workflowFileActions);
    this.agentProposalController = new ProgressAgentProposalController(
      options.agentProposal,
    );
    this.commandHandlers = createProgressViewCommandHandlers({
      lifecycle: options.commands.lifecycle,
      run: {
        resumeStream: (stream) => resumeStream(options.run, stream),
        runNewStream: (stream) => runNewStream(options.run, stream),
      },
      followUp: options.commands.followUp,
      bypass: options.commands.bypass,
      file: {
        openFile: options.commands.file.openFile,
        openFileCompile: options.commands.file.openFileCompile,
        openTaskStorage: (stream) =>
          this.workflowFileActionsController.openTaskStorage(stream),
        compareOriginal: (file, base) =>
          this.workflowFileActionsController.compareOriginal(file, base),
        comparePrevious: (file, base, previous) =>
          this.workflowFileActionsController.comparePrevious(
            file,
            base,
            previous,
          ),
        acceptFile: (file, base) =>
          this.workflowFileActionsController.acceptFile(file, base),
        mergeFile: (file, base) =>
          this.workflowFileActionsController.mergeFile(file, base),
        latexdiffFile: (file, base) =>
          this.workflowFileActionsController.latexdiffFile(file, base),
        openLabel: (label) =>
          this.workflowFileActionsController.openLabel(label),
      },
      approval: {
        ...options.commands.approval,
        handleAgentProposalAction: (message) =>
          this.agentProposalController.handleAction(message),
      },
      externalInquiry: options.commands.externalInquiry,
    });
  }
}
