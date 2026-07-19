// Local imports - agent
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import {
  isWorkflowTaskState,
  type TaskState,
} from '@agent/core/state/TaskState';
import type { StreamTabId } from '@shared/schemas';

// Local imports - shared

// Local imports - controllers
import {
  createProgressViewCommandHandlers,
  type ProgressViewApprovalCommandActions,
  type ProgressViewBypassCommandOptions,
  type ProgressViewExternalInquiryCommandActions,
  type ProgressViewFileCommandActions,
  type ProgressViewFollowUpCommandActions,
  type ProgressViewLifecycleCommandActions,
  type ProgressViewRunCommandActions,
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
  readonly resumeStream?: ProgressViewRunCommandActions['resumeStream'];
  readonly followUp: ProgressViewFollowUpCommandActions;
  readonly bypass: ProgressViewBypassCommandOptions;
  readonly file: ProgressViewFileHostActions;
  readonly approval: ProgressViewApprovalHostActions;
  readonly externalInquiry: ProgressViewExternalInquiryCommandActions;
}

interface ProgressViewRunState {
  getTaskState(stream: StreamTabId): TaskState | undefined;
  getExecutionId(stream: StreamTabId): string | undefined;
}

interface ProgressViewRunDependencies {
  readonly state: ProgressViewRunState;
  executeAgent(request: ExecutionRequest): Promise<void>;
}

async function resumeStream(
  dependencies: ProgressViewRunDependencies,
  stream: StreamTabId,
): Promise<void> {
  const taskState = dependencies.state.getTaskState(stream);
  if (!taskState) return;

  const executionId = isWorkflowTaskState(taskState)
    ? dependencies.state.getExecutionId(stream)
    : undefined;

  await dependencies.executeAgent({
    config: taskState.agentConfig,
    ...(executionId && { executionId }),
  });
}

async function runNewStream(
  dependencies: ProgressViewRunDependencies,
  stream: StreamTabId,
): Promise<void> {
  const taskState = dependencies.state.getTaskState(stream);
  if (!taskState) return;

  await dependencies.executeAgent({ config: taskState.agentConfig });
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
        resumeStream:
          options.commands.resumeStream ??
          ((stream) => resumeStream(options.run, stream)),
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
