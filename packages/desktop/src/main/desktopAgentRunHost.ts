import type { Dialogs, DiffViewHost, HostFailed } from '@texra/hosts/uiHosts';
import type { TranscriptExportFormat } from '@texra/controllers/progressView/exportTranscript';
import type { BuildDisplayFn } from '@texra/controllers/approval/latexPreview';
import type { AskNotice } from '@texra/controllers/session/windowNotices';
import type { Effect } from 'effect';

/** Required desktop capabilities used throughout an agent run. */
export interface DesktopAgentRunHost {
  /** A notice naming the run's project. */
  readonly notify: Dialogs['notify'];
  /** A notice with one button per label, naming the run's project. */
  readonly ask: AskNotice;
  /** The export's format dialog. The Electron dialog behind it is a
   *  promise, lifted once there; a cancelled dialog answers `undefined`. */
  pickTranscriptExportFormat(): Effect.Effect<
    TranscriptExportFormat | undefined,
    HostFailed
  >;
  /** `line` is carried for the hosts that can reveal one; the desktop hands
   *  the path to the OS. */
  openPath(filePath: string, line?: number): Effect.Effect<void, HostFailed>;
  openBuildDisplay: BuildDisplayFn;
  openDiff: DiffViewHost['openDiff'];
  confirm: Dialogs['confirm'];
}
