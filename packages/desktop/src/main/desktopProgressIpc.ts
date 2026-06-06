import { createProgressViewApprovalCommandHandlers } from '@controllers/progressView/ProgressViewApprovalCommandHandlers';
import { createProgressViewBypassCommandHandlers } from '@controllers/progressView/ProgressViewBypassCommandHandlers';
import { createProgressViewFileCommandHandlers } from '@controllers/progressView/ProgressViewFileCommandHandlers';
import { createProgressViewFollowUpCommandHandlers } from '@controllers/progressView/ProgressViewFollowUpCommandHandlers';
import { createProgressViewLifecycleCommandHandlers } from '@controllers/progressView/ProgressViewLifecycleCommandHandlers';
import { createProgressViewRunCommandHandlers } from '@controllers/progressView/ProgressViewRunCommandHandlers';
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
    ...createProgressViewLifecycleCommandHandlers({
      setActiveStream: (stream) => progress.setActiveStream(stream),
      setAgentFilter: (filter) => progress.setAgentFilter(filter),
      deleteStream: (stream) => progress.deleteStream(stream),
      deleteAllStreams: () => progress.deleteAllStreams(),
      stopStream: (stream) => progress.stopStream(stream),
    }),
    ...createProgressViewRunCommandHandlers({
      resumeStream: (stream) => progress.resumeStream(stream),
      runNewStream: (stream) => progress.runNewStream(stream),
    }),
    ...createProgressViewFollowUpCommandHandlers({
      sendFollowUp: ({ stream, text, mediaFiles }) =>
        progress.sendFollowUp(stream, text, mediaFiles),
      reportImageSaveError: (_image, error) => reportAsyncError(error),
    }),
    ...createProgressViewBypassCommandHandlers({
      runtimeHost: progress.runtimeHost,
    }),
    ...createProgressViewFileCommandHandlers({
      openFile: (file, line) => progress.openFile(file, line),
      openFileCompile: (file) => progress.openFileCompile(file),
      openTaskStorage: (stream) => progress.openTaskStorage(stream),
      compareOriginal: (file, base) => progress.compareOriginal(file, base),
      comparePrevious: (file, base, previous) =>
        progress.comparePrevious(file, base, previous),
      acceptFile: (file, base) => progress.acceptFile(file, base),
      mergeFile: (file, base) => progress.mergeFile(file, base),
      latexdiffFile: (file, base) => progress.latexdiffFile(file, base),
      openLabel: (label) => progress.openLabel(label),
    }),
    ...createProgressViewApprovalCommandHandlers({
      handleToolEditApprovalAction: (message) =>
        progress.handleToolEditApprovalAction(message),
      onUnsupportedToolEditApproval: (message) => onUnsupportedCommand(message),
      handleBashApprovalAction: (message) =>
        progress.handleBashApprovalAction(message),
      handlePlanApprovalAction: (message) =>
        progress.handlePlanApprovalAction(message),
      handleUserQuestionAction: (message) =>
        progress.handleUserQuestionAction(message),
      handleAgentProposalAction: (message) =>
        progress.handleAgentProposalAction(message),
    }),
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
