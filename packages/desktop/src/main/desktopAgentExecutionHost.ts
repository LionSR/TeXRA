import type { MainViewExecutionLaunchHost } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import type { DiffViewHost } from '@hosts/uiHosts';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';

/** Required desktop capabilities used throughout an agent execution. */
export interface DesktopAgentExecutionHost extends MainViewExecutionLaunchHost {
  showErrorMessage(message: string): Promise<void> | void;
  showWarningMessage(message: string): Promise<void> | void;
  showInfoMessage(message: string): Promise<void> | void;
  openPath(filePath: string, line?: number): Promise<void>;
  openBuildDisplay: BuildDisplayFn;
  openDiff: DiffViewHost['openDiff'];
  confirmAcceptFile(message: string): Promise<boolean>;
  /** Recompute window state derived from a newly completed run. */
  onRunCompleted(): void;
}
