import { writeSync } from 'node:fs';
import { basename } from 'node:path';

import {
  formatSessionTitle,
  type SessionTitleState,
} from '@shared/sessionTitle';
import { isActivePhase } from '@shared/streams/streamStatus';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

import { approvalQueueStatus } from './state/approvalQueue';
import { rootRunPending, rootRunStreamId, streams } from './state/cliState';
import { chatTuiCanStopActiveRun } from './state/sessionRunState';
import { subscribeToSignalChanges } from './state/signalSubscription';
import { terminalCapabilities } from './state/terminalCapabilities';

// Directory names can contain characters that would prematurely terminate
// the OSC string (a stray BEL/ESC) or that some terminals in 8-bit mode
// still interpret as escape-sequence introducers (the C1 range, e.g. 0x9d
// as an 8-bit OSC); strip both C0 and C1 controls so a weird folder name
// can't inject terminal escape sequences into the title.
// eslint-disable-next-line no-control-regex -- stripping C0/C1 controls
const TITLE_INVALID_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const RUNNING_TITLE_FRAMES = ['-', '/', '\\'] as const;
const RUNNING_TITLE_INTERVAL_MS = 500;

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

/** Keep the terminal title synchronized with existing TUI state. */
export function installTerminalTitleUpdates(cwd: string) {
  let disposed = false;
  let suspended = false;
  let lastTitle: string | undefined;
  let runningFrame = 0;
  let runningTimer: ReturnType<typeof setInterval> | undefined;
  const stopRunningAnimation = (): void => {
    if (runningTimer === undefined) return;
    clearInterval(runningTimer);
    runningTimer = undefined;
  };
  const updateTitle = (title: string): void => {
    if (title === lastTitle) return;
    lastTitle = title;
    writeTerminalTitle(title);
  };
  const runningTitle = (): string =>
    terminalTitleText(cwd, 'running', RUNNING_TITLE_FRAMES[runningFrame]);
  const startRunningAnimation = (): void => {
    if (runningTimer !== undefined) return;
    if (!terminalCapabilities.get().oscColorReports) return;
    runningFrame = 0;
    updateTitle(runningTitle());
    runningTimer = setInterval(() => {
      if (!terminalCapabilities.get().oscColorReports) {
        stopRunningAnimation();
        return;
      }
      runningFrame = (runningFrame + 1) % RUNNING_TITLE_FRAMES.length;
      updateTitle(runningTitle());
    }, RUNNING_TITLE_INTERVAL_MS);
    runningTimer.unref?.();
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
