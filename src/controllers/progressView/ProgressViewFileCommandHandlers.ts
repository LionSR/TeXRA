// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';

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

export function createProgressViewFileCommandHandlers(
  actions: ProgressViewFileCommandActions,
): ProgressViewInboundHandlerRegistry {
  return {
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (data) =>
      actions.openFile(data.file, data.line),
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: (data) =>
      actions.openFileCompile(data.file),
    [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]: (data) =>
      actions.openTaskStorage(data.stream),
    [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (data) =>
      actions.compareOriginal(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (data) =>
      actions.comparePrevious(data.file, data.base, data.prev),
    [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (data) =>
      actions.acceptFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (data) =>
      actions.mergeFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (data) =>
      actions.latexdiffFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: (data) =>
      actions.openLabel(data.label),
  };
}
