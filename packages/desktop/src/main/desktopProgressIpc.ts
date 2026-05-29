import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import {
  dispatchProgressViewInbound,
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundHandlerRegistry,
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
    options.onUnsupportedCommand ?? defaultUnsupportedCommand;
  const progress = options.progress;

  const progressHandlers: ProgressViewInboundHandlerRegistry = {
    [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (d) =>
      progress.setActiveStream(d.stream),
    [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]: (d) =>
      progress.setAgentFilter(d.filter),
    [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (d) =>
      progress.deleteStream(d.stream),
    [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => progress.deleteAllStreams(),
    [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (d) => progress.stopStream(d.stream),
    [PROGRESS_VIEW_COMMANDS.RESUME]: (d) => progress.resumeStream(d.stream),
    [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (d) => progress.runNewStream(d.stream),
    [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: (d) =>
      progress.sendFollowUp(d.stream, d.text),
    [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]: (d) => {
      if (!progress.handleToolEditApprovalAction(d)) onUnsupportedCommand(d);
    },
    [PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION]: (d) =>
      progress.handleBashApprovalAction(d),
    [PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION]: (d) =>
      progress.handlePlanApprovalAction(d),
    [PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION]: (d) =>
      progress.handleUserQuestionAction(d),
    [PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]: async (d) => {
      await progress.handleAgentProposalAction(d);
    },
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (d) =>
      progress.openFile(d.file, d.line),
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: (d) =>
      progress.openFileCompile(d.file),
    [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]: (d) =>
      progress.openTaskStorage(d.stream),
    [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (d) =>
      progress.compareOriginal(d.file, d.base),
    [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (d) =>
      progress.comparePrevious(d.file, d.base, d.prev),
    [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (d) =>
      progress.acceptFile(d.file, d.base),
    [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (d) =>
      progress.mergeFile(d.file, d.base),
    [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (d) =>
      progress.latexdiffFile(d.file, d.base),
    [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: (d) => progress.openLabel(d.label),
  };

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const result = ProgressViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      const command = result.data.command;
      // WEBVIEW_READY and pass-through commands return false so sibling
      // handlers in the chain still receive them.
      if (command === PROGRESS_VIEW_COMMANDS.WEBVIEW_READY) {
        progress.syncFullView();
        return false;
      }
      if (passThroughCommands.has(command)) return false;

      if (
        dispatchProgressViewInbound(message, progressHandlers, reportAsyncError)
      ) {
        return true;
      }
      // Recognized but unhandled command: consume it with a warning.
      onUnsupportedCommand(result.data);
      return true;
    },
  };
}

function defaultUnsupportedCommand(message: ProgressViewInboundMessage): void {
  console.warn(`Unsupported desktop Progress command: ${message.command}`);
}
