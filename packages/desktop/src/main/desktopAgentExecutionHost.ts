import type { MainViewExecutionLaunchHost } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import type { TranscriptExportFormat } from '@controllers/progressView/exportTranscript';
import type { DiffViewHost, MessageHost } from '@hosts/uiHosts';
import type { InstructionAction } from '@shared/schemas';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';

/** Required desktop capabilities used throughout an agent execution. */
export interface DesktopAgentExecutionHost
  extends MainViewExecutionLaunchHost, MessageHost {
  /**
   * Presents an instruction (e.g. a missing API key) as an actionable
   * dialog: each token in `actions` becomes a button — dispatched to the
   * matching main-process action (open Settings, open a doc) — plus a
   * defaulted "Dismiss", instead of degrading to inert trailing hint text.
   */
  showInstructionDialog(
    message: string,
    actions: readonly InstructionAction[] | undefined,
  ): Promise<void>;
  pickTranscriptExportFormat(): Promise<TranscriptExportFormat | undefined>;
  openPath(filePath: string, line?: number): Promise<void>;
  openBuildDisplay: BuildDisplayFn;
  openDiff: DiffViewHost['openDiff'];
  confirmAcceptFile(message: string): Promise<boolean>;
  /** Recompute window state derived from a newly completed run. */
  onRunCompleted(): void;
}
