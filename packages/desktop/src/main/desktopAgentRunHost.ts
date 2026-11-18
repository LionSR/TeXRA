import type { Dialogs, DiffViewHost } from '@texra/hosts/uiHosts';
import type { TranscriptExportFormat } from '@texra/controllers/progressView/exportTranscript';
import type { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import type { BuildDisplayFn } from '@texra/controllers/approval/latexPreview';
import type { windowNotices } from '@texra/controllers/session/windowNotices';
import type { Effect } from 'effect';

import type { DesktopCommandFailed } from './desktopIpcTypes.js';

/** Required desktop capabilities used throughout an agent run. */
export interface DesktopAgentRunHost {
  /** A notice naming the run's project. */
  readonly notify: Dialogs['notify'];
  /** The window's failure and instruction notices, naming the run's
   *  project. */
  readonly notices: ReturnType<typeof windowNotices>;
  /** The export's format dialog. The Electron dialog behind it is a
   *  promise, lifted once there; a cancelled dialog answers `undefined`. */
  pickTranscriptExportFormat(): Effect.Effect<
    TranscriptExportFormat | undefined,
    TranscriptExportFailed
  >;
  /** `line` is carried for the hosts that can reveal one; the desktop hands
   *  the path to the OS. */
  openPath(
    filePath: string,
    line?: number,
  ): Effect.Effect<void, DesktopCommandFailed>;
  openBuildDisplay: BuildDisplayFn;
  openDiff: DiffViewHost['openDiff'];
  confirm: Dialogs['confirm'];
}
