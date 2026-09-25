import { basename } from 'node:path';

import { osc } from '@cli/runtime/ansiEscapes';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { subscribeToPolling } from '@cli/tui/usePollingInterval';
import {
  formatSessionTitle,
  TERMINAL_TAB_TITLE,
  type SessionTitleState,
} from '@shared/sessionTitle';
import { subscribeToSignalChanges } from '@shared/signals';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

import { claimedRunId, rootRunId, rootRunPending } from './state/cliState';
import { attentionRequests } from './state/approvalQueue';
import {
  anyRunRunning,
  sessionView,
  runPhaseOf,
  runViewOf,
} from './state/sessionView';
import { writeOsc } from './notifications/terminalNotifier';
import { chatTuiCanStopActiveRun } from './state/sessionRunState';

// Directory names can contain characters that would prematurely terminate
// the OSC string (a stray BEL/ESC) or that some terminals in 8-bit mode
// still interpret as escape-sequence introducers (the C1 range, e.g. 0x9d
// as an 8-bit OSC); strip both C0 and C1 controls so a weird folder name
// can't inject terminal escape sequences into the title.
// eslint-disable-next-line no-control-regex -- stripping C0/C1 controls
const TITLE_INVALID_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

// The TUI's ASCII spin cycle reads as stray punctuation once a frame stands
// alone in a tab title (a `-` is indistinguishable from a separator), so the
// title spins through braille dots instead. Quarter-turn steps, because the
// shared clock ticks at 1 Hz and a ten-frame cycle would crawl.
const TITLE_FRAMES = ['⠋', '⠹', '⠴', '⠦'] as const;

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
  return formatSessionTitle(project, state, {
    detail: activityDetail,
    style: TERMINAL_TAB_TITLE,
  });
}

function currentTerminalTitleState(): SessionTitleState {
  const view = sessionView().get();
  if (attentionRequests(view).length > 0) return 'approval';
  const runId = claimedRunId.get();
  if (
    chatTuiCanStopActiveRun({
      runPending: rootRunPending.get(),
      runId,
      status: runPhaseOf(runViewOf(view, runId)),
    }) ||
    anyRunRunning(view, rootRunId.get())
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
    writeOsc(osc(`0;${title}`));
  };
  // Frame is derived from wall time via `loadingFrameAt`, the same 1 Hz
  // rotation `LoadingIndicator` and the status bar use, so the tab title
  // joins the shared clock instead of running its own interval.
  const runningTitle = (): string =>
    terminalTitleText(cwd, 'running', loadingFrameAt(Date.now(), TITLE_FRAMES));
  const startRunningAnimation = (): void => {
    if (stopSharedTick !== undefined) return;
    updateTitle(runningTitle());
    stopSharedTick = subscribeToPolling(1000, () =>
      updateTitle(runningTitle()),
    );
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
    [sessionView(), claimedRunId, rootRunPending, rootRunId],
    synchronize,
  );
  synchronize();

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
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      restoreIdleTitle();
    },
  };
}
