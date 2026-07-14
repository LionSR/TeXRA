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
  ProgressWorkflowActionsController,
  type ProgressWorkflowActionsControllerDeps,
} from './ProgressWorkflowActionsController';
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

export interface ProgressViewHostCommandOptions {
  readonly lifecycle: ProgressViewLifecycleCommandActions;
  readonly resumeStream?: ProgressViewRunCommandActions['resumeStream'];
  readonly followUp: ProgressViewFollowUpCommandActions;
  readonly bypass: ProgressViewBypassCommandOptions;
  readonly file: ProgressViewFileHostActions;
  readonly approval: ProgressViewApprovalHostActions;
  readonly externalInquiry: ProgressViewExternalInquiryCommandActions;
}

export interface ProgressViewHostOptions {
  readonly workflowActions: ProgressWorkflowActionsControllerDeps;
  readonly workflowFileActions: ProgressWorkflowFileActionsControllerDeps;
  readonly agentProposal: ProgressAgentProposalControllerDeps;
  readonly commands: ProgressViewHostCommandOptions;
}

export class ProgressViewHost {
  readonly workflowActionsController: ProgressWorkflowActionsController;
  readonly workflowFileActionsController: ProgressWorkflowFileActionsController;
  readonly agentProposalController: ProgressAgentProposalController;
  readonly commandHandlers: ReturnType<
    typeof createProgressViewCommandHandlers
  >;

  constructor(options: ProgressViewHostOptions) {
    this.workflowActionsController = new ProgressWorkflowActionsController(
      options.workflowActions,
    );
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
          ((stream) => this.workflowActionsController.resume(stream)),
        runNewStream: (stream) => this.workflowActionsController.runNew(stream),
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
