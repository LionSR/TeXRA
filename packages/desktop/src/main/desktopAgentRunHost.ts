import type { Effect } from 'effect';

import type { MainViewRunLaunchHost } from '@controllers/mainView/backend/MainViewRunLaunchController';
import type { TranscriptExportFormat } from '@controllers/progressView/exportTranscript';
import type { DiffViewHost, MessageHost } from '@hosts/uiHosts';
import type { InstructionAction } from '@shared/schemas';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';

import type { PreviewUnavailable } from './desktopPreviewHost.js';

/** Required desktop capabilities used throughout an agent run. */
export interface DesktopAgentRunHost
  extends MainViewRunLaunchHost, MessageHost {
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
  /**
   * Presents a failure dialog. A `docsCommand` (from a refusing request's
   * `Rejected`) adds a guide button opening the matching docs page — the
   * native form of the link the extension's request-error callout renders.
   */
  showErrorDialog(message: string, docsCommand?: string): Promise<void>;
  pickTranscriptExportFormat(): Promise<TranscriptExportFormat | undefined>;
  /** The window's shell-facing open verb, Effect-typed since the ruling of
   *  2026-09-18 retired this fan-out's Promise face. `line` is carried for the
   *  hosts that can reveal one; the desktop hands the path to the OS. */
  openPath(
    filePath: string,
    line?: number,
  ): Effect.Effect<void, PreviewUnavailable>;
  openBuildDisplay: BuildDisplayFn;
  openDiff: DiffViewHost['openDiff'];
  confirmAcceptFile(message: string): Promise<boolean>;
}
