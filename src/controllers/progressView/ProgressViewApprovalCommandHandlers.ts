// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
} from '@shared/schemas/progressView';

type ApprovalMessage<C extends ProgressViewInboundMessage['command']> = Extract<
  ProgressViewInboundMessage,
  { command: C }
>;

export interface ProgressViewApprovalCommandActions {
  handleToolEditApprovalAction(
    message: ApprovalMessage<
      typeof PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
    >,
  ): boolean | Promise<boolean>;
  onUnsupportedToolEditApproval?(
    message: ApprovalMessage<
      typeof PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
    >,
  ): void;
  handleBashApprovalAction(
    message: ApprovalMessage<
      typeof PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION
    >,
  ): unknown;
  handlePlanApprovalAction(
    message: ApprovalMessage<
      typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION
    >,
  ): unknown;
  handleUserQuestionAction(
    message: ApprovalMessage<
      typeof PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION
    >,
  ): unknown;
  handleAgentProposalAction(
    message: ApprovalMessage<
      typeof PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION
    >,
  ): unknown;
}

export function createProgressViewApprovalCommandHandlers(
  actions: ProgressViewApprovalCommandActions,
): ProgressViewInboundHandlerRegistry {
  return {
    [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]: (data) => {
      const handled = actions.handleToolEditApprovalAction(data);
      if (handled instanceof Promise) {
        return handled.then((result) => {
          if (result === false) {
            actions.onUnsupportedToolEditApproval?.(data);
          }
        });
      }
      if (handled === false) {
        actions.onUnsupportedToolEditApproval?.(data);
      }
    },
    [PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION]: async (data) => {
      await actions.handleBashApprovalAction(data);
    },
    [PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION]: async (data) => {
      await actions.handlePlanApprovalAction(data);
    },
    [PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION]: async (data) => {
      await actions.handleUserQuestionAction(data);
    },
    [PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]: async (data) => {
      await actions.handleAgentProposalAction(data);
    },
  };
}
