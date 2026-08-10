// Local imports
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import { platform } from '@platform/platform';
import type { StreamTabId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';

// Local file imports
import {
  createProgressViewCommandHandlers,
  isNativeAgentRun,
  reportNonNativeRunRefusal,
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
  getRunMetadata(stream: StreamTabId): RunMetadata;
}

interface ProgressViewRunDependencies {
  readonly state: ProgressViewRunState;
  /**
   * Launch or resume a run for this request. This is a host callback, not
   * the `@agent/runtime` `executeAgent`/`runAgent` functions it dispatches
   * to — hosts wire it to their own command/IPC handling, which eventually
   * reaches `runAgent`.
   */
  runExecutionRequest(request: ExecutionRequest): Promise<void>;
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
  showInfo: (message: string) => void | PromiseLike<unknown>,
): Promise<void> {
  const { config, executionId, identity } =
    dependencies.state.getRunMetadata(stream);
  if (!isNativeAgentRun(identity)) {
    await reportNonNativeRunRefusal(showInfo, 'resumed');
    return;
  }
  if (!config) return;

  if (config.agentCategory !== AgentCategory.Workflow) {
    await platform().agentResume.tryResumeStream(stream);
    return;
  }

  await dependencies.runExecutionRequest({
    config,
    ...(executionId && { executionId }),
  });
}

async function runNewStream(
  dependencies: ProgressViewRunDependencies,
  stream: StreamTabId,
  showInfo: (message: string) => void | PromiseLike<unknown>,
): Promise<void> {
  const { config, identity } = dependencies.state.getRunMetadata(stream);
  if (!isNativeAgentRun(identity)) {
    await reportNonNativeRunRefusal(showInfo, 're-run');
    return;
  }
  if (!config) return;

  await dependencies.runExecutionRequest({ config });
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
        resumeStream: (stream) =>
          resumeStream(options.run, stream, options.commands.bypass.showInfo),
        runNewStream: (stream) =>
          runNewStream(options.run, stream, options.commands.bypass.showInfo),
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
