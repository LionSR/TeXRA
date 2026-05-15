import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import {
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';

import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopProgressBridge } from './desktopAgentExecution.js';

export interface DesktopProgressIpcOptions {
  progress: DesktopProgressBridge;
  onUnsupportedCommand?: (message: ProgressViewInboundMessage) => void;
  onAsyncError?: (error: unknown) => void;
}

export type DesktopProgressIpc = DesktopMessageHandler;

const passThroughCommands = new Set<string>([
  PROGRESS_VIEW_COMMANDS.SWITCH_VIEW,
  PROGRESS_VIEW_COMMANDS.THEME_SET,
  PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET,
]);

export function createDesktopProgressIpc(
  options: DesktopProgressIpcOptions,
): DesktopProgressIpc {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);
  const onUnsupportedCommand =
    options.onUnsupportedCommand ??
    ((message) => {
      console.warn(`Unsupported desktop Progress command: ${message.command}`);
    });

  function runAsync(work: Promise<unknown>): void {
    void work.catch(reportAsyncError);
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const result = ProgressViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      switch (result.data.command) {
        case PROGRESS_VIEW_COMMANDS.WEBVIEW_READY:
          options.progress.syncFullView();
          return false;
        case PROGRESS_VIEW_COMMANDS.SWITCH_STREAM:
          options.progress.setActiveStream(result.data.stream);
          return true;
        case PROGRESS_VIEW_COMMANDS.FILTER_STREAMS:
          options.progress.setAgentFilter(result.data.filter);
          return true;
        case PROGRESS_VIEW_COMMANDS.DELETE_STREAM:
          runAsync(options.progress.deleteStream(result.data.stream));
          return true;
        case PROGRESS_VIEW_COMMANDS.DELETE_ALL:
          runAsync(options.progress.deleteAllStreams());
          return true;
        case PROGRESS_VIEW_COMMANDS.STOP_STREAM:
          options.progress.stopStream(result.data.stream);
          return true;
        case PROGRESS_VIEW_COMMANDS.RESUME:
          runAsync(options.progress.resumeStream(result.data.stream));
          return true;
        case PROGRESS_VIEW_COMMANDS.RUN_NEW:
          runAsync(options.progress.runNewStream(result.data.stream));
          return true;
        case PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP:
          runAsync(
            options.progress.sendFollowUp(result.data.stream, result.data.text),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION:
          if (options.progress.handleToolEditApprovalAction(result.data)) {
            return true;
          }
          onUnsupportedCommand(result.data);
          return true;
        case PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION:
          runAsync(options.progress.handleBashApprovalAction(result.data));
          return true;
        case PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION:
          options.progress.handlePlanApprovalAction(result.data);
          return true;
        case PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION:
          runAsync(options.progress.handleUserQuestionAction(result.data));
          return true;
        case PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION:
          runAsync(options.progress.handleAgentProposalAction(result.data));
          return true;
        case PROGRESS_VIEW_COMMANDS.OPEN_FILE:
          runAsync(
            options.progress.openFile(result.data.file, result.data.line),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE:
          runAsync(options.progress.openFileCompile(result.data.file));
          return true;
        case PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE:
          runAsync(options.progress.openTaskStorage(result.data.stream));
          return true;
        case PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL:
          runAsync(
            options.progress.compareOriginal(
              result.data.file,
              result.data.base,
            ),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS:
          runAsync(
            options.progress.comparePrevious(
              result.data.file,
              result.data.base,
              result.data.prev,
            ),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.ACCEPT_FILE:
          runAsync(
            options.progress.acceptFile(result.data.file, result.data.base),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.MERGE_FILE:
          runAsync(
            options.progress.mergeFile(result.data.file, result.data.base),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE:
          runAsync(
            options.progress.latexdiffFile(result.data.file, result.data.base),
          );
          return true;
        case PROGRESS_VIEW_COMMANDS.OPEN_LABEL:
          runAsync(options.progress.openLabel(result.data.label));
          return true;
        default:
          if (passThroughCommands.has(result.data.command)) return false;
          onUnsupportedCommand(result.data);
          return true;
      }
    },
  };
}
