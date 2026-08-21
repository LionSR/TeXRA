import { writeSync } from 'node:fs';
import { basename } from 'node:path';

import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { subscribeToSharedTick } from '@cli/tui/useLiveNowMs';
import {
  formatSessionTitle,
  type SessionTitleState,
} from '@shared/sessionTitle';
import { subscribeToSignalChanges } from '@shared/signals';
import { isActivePhase } from '@shared/streams/streamStatus';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

import { approvalQueueStatus } from './state/approvalQueue';
import { rootRunPending, rootRunStreamId, streams } from './state/cliState';
import { chatTuiCanStopActiveRun } from './state/sessionRunState';
import { terminalCapabilities } from './state/terminalCapabilities';

// Directory names can contain characters that would prematurely terminate
// the OSC string (a stray BEL/ESC) or that some terminals in 8-bit mode
// still interpret as escape-sequence introducers (the C1 range, e.g. 0x9d
// as an 8-bit OSC); strip both C0 and C1 controls so a weird folder name
// can't inject terminal escape sequences into the title.
// eslint-disable-next-line no-control-regex -- stripping C0/C1 controls
const TITLE_INVALID_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/** Project-aware terminal title, optionally annotated with live TUI state. */
export function terminalTitleText(
  cwd: string,
  state: SessionTitleState = 'idle',
  activityDetail?: string,
): string {
  const project = sanitizePathSegment(basename(cwd), {
    invalidCharPattern: TITLE_INVALID_CHARS,
    replacement: '',
  });
  return formatSessionTitle(project, state, activityDetail);
}

/** Write the title only when terminal capability discovery admitted OSC. */
function writeTerminalTitle(title: string): void {
  if (!terminalCapabilities.get().oscColorReports) return;
  try {
    writeSync(1, `\x1b]0;${title}\x07`);
  } catch {
    // The tab title is cosmetic; a write failure here isn't actionable.
  }
}

function currentTerminalTitleState(): SessionTitleState {
  if (approvalQueueStatus.get().depth > 0) return 'approval';
  const streamSlices = streams.get();
  const rootStreamId = rootRunStreamId.get();
  if (
    chatTuiCanStopActiveRun({
      runPending: rootRunPending.get(),
      streamId: rootStreamId,
      status: rootStreamId ? streamSlices.get(rootStreamId)?.status : undefined,
    }) ||
    [...streamSlices.values()].some((stream) => isActivePhase(stream.status))
  ) {
    return 'running';
  }
  return 'idle';
}

interface TerminalTitleController {
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly dispose: () => void;
}

/** Keep the terminal title synchronized with existing TUI state. */
export function installTerminalTitleUpdates(
  cwd: string,
): TerminalTitleController {
  let disposed = false;
  let suspended = false;
  let lastTitle: string | undefined;
  let stopSharedTick: (() => void) | undefined;
  const stopRunningAnimation = (): void => {
    stopSharedTick?.();
    stopSharedTick = undefined;
  };
  const updateTitle = (title: string): void => {
    if (title === lastTitle) return;
    lastTitle = title;
    writeTerminalTitle(title);
  };
  // Frame is derived from wall time via `loadingFrameAt`, the same 1 Hz
  // rotation `LoadingIndicator` and the status bar use, so the tab title
  // joins the shared clock instead of running its own interval.
  const runningTitle = (): string =>
    terminalTitleText(cwd, 'running', loadingFrameAt(Date.now()));
  const startRunningAnimation = (): void => {
    if (stopSharedTick !== undefined) return;
    if (!terminalCapabilities.get().oscColorReports) return;
    updateTitle(runningTitle());
    stopSharedTick = subscribeToSharedTick(() => {
      if (!terminalCapabilities.get().oscColorReports) {
        stopRunningAnimation();
        return;
      }
      updateTitle(runningTitle());
    });
  };
  const synchronize = (): void => {
    if (suspended) return;
    const state = currentTerminalTitleState();
    if (state === 'running') {
      startRunningAnimation();
      return;
    }
    stopRunningAnimation();
    updateTitle(terminalTitleText(cwd, state));
  };
  const restoreIdleTitle = (): void => {
    stopRunningAnimation();
    updateTitle(terminalTitleText(cwd));
  };
  const unsubscribe = subscribeToSignalChanges(
    [approvalQueueStatus, rootRunPending, rootRunStreamId, streams],
    synchronize,
  );
  synchronize();
  // Synchronous signal exits bypass the normal disposer loop, but still emit
  // `exit`; restore the title there as well as during graceful teardown.
  process.on('exit', restoreIdleTitle);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    process.off('exit', restoreIdleTitle);
    restoreIdleTitle();
  };

  return {
    suspend: () => {
      if (disposed) return;
      suspended = true;
      restoreIdleTitle();
    },
    resume: () => {
      if (disposed) return;
      suspended = false;
      synchronize();
    },
    dispose,
  };
}
