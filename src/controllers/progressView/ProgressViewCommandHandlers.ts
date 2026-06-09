// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategoryFilter, StreamTabId } from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';

// Local imports - controllers
import {
  createProgressViewApprovalCommandHandlers,
  type ProgressViewApprovalCommandActions,
} from './ProgressViewApprovalCommandHandlers';
import {
  createProgressViewBypassCommandHandlers,
  type ProgressViewBypassCommandOptions,
} from './ProgressViewBypassCommandHandlers';
import {
  createProgressViewFollowUpCommandHandlers,
  type ProgressViewFollowUpCommandActions,
} from './ProgressViewFollowUpCommandHandlers';

export interface ProgressViewLifecycleCommandActions {
  setActiveStream(stream: StreamTabId): Promise<void> | void;
  setAgentFilter(filter: AgentCategoryFilter): Promise<void> | void;
  deleteStream(stream: StreamTabId): Promise<void> | void;
  deleteAllStreams(): Promise<void> | void;
  stopStream(stream: StreamTabId): Promise<void> | void;
}

export interface ProgressViewRunCommandActions {
  resumeStream(stream: StreamTabId): Promise<void> | void;
  runNewStream(stream: StreamTabId): Promise<void> | void;
}

export interface ProgressViewFileCommandActions {
  openFile(file: string, line?: number): Promise<void> | void;
  openFileCompile(file: string): Promise<void> | void;
  openTaskStorage(stream: StreamTabId): Promise<void> | void;
  compareOriginal(file: string, base?: string): Promise<void> | void;
  comparePrevious(
    file: string,
    base?: string,
    previous?: string,
  ): Promise<void> | void;
  acceptFile(file: string, base?: string): Promise<void> | void;
  mergeFile(file: string, base?: string): Promise<void> | void;
  latexdiffFile(file: string, base?: string): Promise<void> | void;
  openLabel(label: string): Promise<void> | void;
}

export interface ProgressViewCommandActions {
  lifecycle: ProgressViewLifecycleCommandActions;
  run: ProgressViewRunCommandActions;
  followUp: ProgressViewFollowUpCommandActions;
  bypass: ProgressViewBypassCommandOptions;
  file: ProgressViewFileCommandActions;
  approval: ProgressViewApprovalCommandActions;
}

/**
 * Shared progress-view command groups used by both extension and desktop.
 *
 * Host-only commands stay with each host; this factory owns the command groups
 * whose routing should not drift across hosts. Lifecycle, run, and file
 * commands are plain action plumbing and route inline; follow-up, bypass, and
 * approval handlers carry shared policy and live in their own modules.
 */
export function createProgressViewCommandHandlers(
  actions: ProgressViewCommandActions,
): ProgressViewInboundHandlerRegistry {
  const { lifecycle, run, file } = actions;
  return {
    [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (data) =>
      lifecycle.setActiveStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]: (data) =>
      lifecycle.setAgentFilter(data.filter),
    [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data) =>
      lifecycle.deleteStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => lifecycle.deleteAllStreams(),
    [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (data) =>
      lifecycle.stopStream(data.stream),

    [PROGRESS_VIEW_COMMANDS.RESUME]: (data) => run.resumeStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (data) => run.runNewStream(data.stream),

    [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (data) =>
      file.openFile(data.file, data.line),
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: (data) =>
      file.openFileCompile(data.file),
    [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]: (data) =>
      file.openTaskStorage(data.stream),
    [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (data) =>
      file.compareOriginal(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (data) =>
      file.comparePrevious(data.file, data.base, data.prev),
    [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (data) =>
      file.acceptFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (data) =>
      file.mergeFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (data) =>
      file.latexdiffFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: (data) => file.openLabel(data.label),

    ...createProgressViewFollowUpCommandHandlers(actions.followUp),
    ...createProgressViewBypassCommandHandlers(actions.bypass),
    ...createProgressViewApprovalCommandHandlers(actions.approval),
  };
}
