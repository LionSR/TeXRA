import '@test/support/defaultSessionTestSetup';

import { writeSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  bindChildStreamState,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';

import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import {
  clearApprovals,
  enqueueApproval,
} from '@cli/chat/tui/state/approvalQueue';
import {
  resetCliState,
  rootRunPending,
  rootRunStreamId,
} from '@cli/chat/tui/state/cliState';
import {
  installTerminalRestoreOnExit,
  supportsTerminalJobControl,
  tuiInputModeRestoreSequence,
} from '@cli/tui/terminalCleanup';
import {
  installTerminalTitleUpdates,
  terminalTitleText,
} from '@cli/chat/tui/terminalTitle';
import { SessionState } from '@controllers/session/SessionState';
import { STREAM_PHASE } from '@shared/schemas';
import { clearAllStreamStatusesForTest } from '@test/support/streamStatusTestUtils';
import { setCliStreamPhase } from '@test/support/cliStreamStatus';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn(),
}));

const NO_TERMINAL_CAPABILITIES = {
  kittyKeyboard: false,
  oscColorReports: false,
};

// The title projects stream phases, which live on the session status machine
// and reach the CLI through the bound `SessionState`.
let sessionState: SessionState;

beforeEach(() => {
  sessionState = new SessionState(defaultSession());
  bindChildStreamState(sessionState);
});

afterEach(() => {
  unbindChildStreamState(sessionState);
  clearAllStreamStatusesForTest(defaultSession().status);
  clearApprovals();
  resetCliState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  // `writeSync` is a vi.fn() created inside the vi.mock() factory above, not
  // a vi.spyOn() wrapping a real implementation — restoreAllMocks() has no
  // "original" to restore it to and leaves its call history untouched, so
  // clear it explicitly or a later test's `not.toHaveBeenCalled()` sees an
  // earlier test's call.
  vi.mocked(writeSync).mockClear();
  terminalCapabilities.set(NO_TERMINAL_CAPABILITIES);
});

/** Put one real approval in the queue: the title reads the queue's own
 *  projection, so the test has to drive it through the queue. */
function queueTitleApproval(streamId: string): void {
  void enqueueApproval({
    kind: 'bash',
    data: {
      requestId: `title-${streamId}`,
      allowBypass: true,
      streamId,
      command: 'echo ok',
    },
  });
}

describe('terminalTitleText', () => {
  it('names the tab after the project folder', () => {
    expect(terminalTitleText('/Users/ray/projects/coauthor')).toBe(
      '{T}·coauthor',
    );
  });

  it('falls back to the bare brand name at the filesystem root', () => {
    expect(terminalTitleText('/')).toBe('{T}');
  });

  it('leads with running and approval labels ahead of the brand name', () => {
    expect(terminalTitleText('/Users/ray/projects/coauthor', 'running')).toBe(
      '⠋ {T}·coauthor',
    );
    expect(terminalTitleText('/Users/ray/projects/coauthor', 'approval')).toBe(
      '⚠ {T}·coauthor',
    );
    expect(terminalTitleText('/', 'running')).toBe('⠋ {T}');
  });

  it('strips control characters out of a hostile folder name', () => {
    expect(terminalTitleText('/tmp/evil\x07\x1b]0;pwned\x07')).toBe(
      '{T}·evil]0;pwned',
    );
  });
});

describe('installTerminalTitleUpdates', () => {
  const enableOscTitles = (): void => {
    terminalCapabilities.set({
      ...NO_TERMINAL_CAPABILITIES,
      oscColorReports: true,
    });
  };
  const flushTitleUpdate = async (): Promise<void> => {
    await Promise.resolve();
  };
  const expectLastTitle = (title: string): void => {
    expect(writeSync).toHaveBeenLastCalledWith(1, `\x1b]0;${title}\x07`);
  };
  /** Advancing the spin timer must not produce any further title writes. */
  const expectNoTitleWrites = (): void => {
    const writes = vi.mocked(writeSync).mock.calls.length;
    vi.advanceTimersByTime(1_500);
    expect(writeSync).toHaveBeenCalledTimes(writes);
  };

  it('shows root launch as running before the first stream status arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    rootRunPending.set(true);

    await flushTitleUpdate();

    expectLastTitle('⠋ {T}·coauthor');
    updates.dispose();
  });

  it('stays running after the root id is published but before its status arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    rootRunPending.set(true);
    rootRunStreamId.set('status-pending-root');

    const updates = installTerminalTitleUpdates('/work/coauthor');

    expectLastTitle('⠋ {T}·coauthor');
    updates.dispose();
  });

  it('uses every stream phase and gives queued approval precedence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    rootRunPending.set(true);
    rootRunStreamId.set('transition-root');
    setCliStreamPhase({
      streamId: 'transition-root',
      status: STREAM_PHASE.WAITING,
    });
    setCliStreamPhase({
      streamId: 'transition-child',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();
    expectLastTitle('⠋ {T}·coauthor');

    queueTitleApproval('title-transition');
    await flushTitleUpdate();
    expectLastTitle('⚠ {T}·coauthor');

    clearApprovals();
    await flushTitleUpdate();
    expectLastTitle('⠋ {T}·coauthor');

    setCliStreamPhase({
      streamId: 'transition-child',
      status: STREAM_PHASE.WAITING,
    });
    await flushTitleUpdate();
    expectLastTitle('{T}·coauthor');
    updates.dispose();
  });

  it('animates running titles and stops the timer outside the running state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    setCliStreamPhase({
      streamId: 'animated-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    // Frame comes from `loadingFrameAt(Date.now(), TITLE_FRAMES)` on the
    // shared 1 Hz tick (braille dots, not the TUI's ASCII spin cycle: a bare
    // `-` reads as punctuation in a tab), not a private timer, so
    // each check advances a full second and the frame is whatever wall time
    // projects to — not reset to index 0 on each animation restart.
    expectLastTitle('⠋ {T}·coauthor');
    vi.advanceTimersByTime(1000);
    expectLastTitle('⠹ {T}·coauthor');
    vi.advanceTimersByTime(1000);
    expectLastTitle('⠴ {T}·coauthor');

    queueTitleApproval('animated-root');
    await flushTitleUpdate();
    expectLastTitle('⚠ {T}·coauthor');
    expectNoTitleWrites();

    clearApprovals();
    await flushTitleUpdate();
    expectLastTitle('⠦ {T}·coauthor');
    updates.suspend();
    expectLastTitle('{T}·coauthor');
    expectNoTitleWrites();

    updates.resume();
    expectLastTitle('⠹ {T}·coauthor');
    setCliStreamPhase({
      streamId: 'animated-root',
      status: STREAM_PHASE.WAITING,
    });
    await flushTitleUpdate();
    expectLastTitle('{T}·coauthor');
    expectNoTitleWrites();

    setCliStreamPhase({
      streamId: 'animated-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();
    expectLastTitle('⠴ {T}·coauthor');
    updates.dispose();
    expectNoTitleWrites();
  });

  it('deduplicates unchanged title projections and resets an active title on teardown', async () => {
    enableOscTitles();
    const on = vi.spyOn(process, 'on');
    const off = vi.spyOn(process, 'off');
    const updates = installTerminalTitleUpdates('/work/coauthor');
    const exitListener = on.mock.calls.find(([event]) => event === 'exit')?.[1];
    setCliStreamPhase({
      streamId: 'dedup-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();
    setCliStreamPhase({
      streamId: 'dedup-child',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    expect(writeSync).toHaveBeenCalledTimes(2);
    updates.dispose();
    expect(writeSync).toHaveBeenCalledTimes(3);
    expectLastTitle('{T}·coauthor');
    expect(off).toHaveBeenCalledWith('exit', exitListener);
  });

  it('restores the idle title from the process-exit path', async () => {
    enableOscTitles();
    const on = vi.spyOn(process, 'on');
    const updates = installTerminalTitleUpdates('/work/coauthor');
    const exitListener = on.mock.calls.find(
      ([event]) => event === 'exit',
    )?.[1] as ((code: number) => void) | undefined;
    setCliStreamPhase({
      streamId: 'exit-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    exitListener?.(0);

    expectLastTitle('{T}·coauthor');
    expect(writeSync).toHaveBeenCalledTimes(3);
    updates.dispose();
    expect(writeSync).toHaveBeenCalledTimes(3);
  });

  it('shows the idle title while suspended and re-projects live state on resume', async () => {
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    setCliStreamPhase({
      streamId: 'suspend-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    updates.suspend();
    expectLastTitle('{T}·coauthor');
    queueTitleApproval('title-suspend');
    await flushTitleUpdate();
    expect(writeSync).toHaveBeenCalledTimes(3);

    updates.resume();
    expectLastTitle('⚠ {T}·coauthor');
    updates.dispose();
  });

  it('keeps sanitization and the OSC capability gate across live transitions', async () => {
    const updates = installTerminalTitleUpdates(
      '/tmp/evil\x07\x1b]0;pwned\x07',
    );
    rootRunPending.set(true);
    await flushTitleUpdate();
    updates.dispose();
    expect(writeSync).not.toHaveBeenCalled();

    enableOscTitles();
    const capableUpdates = installTerminalTitleUpdates(
      '/tmp/evil\x07\x1b]0;pwned\x07',
    );
    rootRunPending.set(false);
    await flushTitleUpdate();
    expectLastTitle('{T}·evil]0;pwned');
    capableUpdates.dispose();
  });
});

describe('tuiInputModeRestoreSequence', () => {
  it('re-arms bracketed paste and cursor hide after a SIGCONT resume', () => {
    expect(tuiInputModeRestoreSequence({ kittyKeyboard: false })).toBe(
      '\x1b[?2004h\x1b[?25l',
    );
  });

  it("re-pushes Ink's kitty disambiguate flag on kitty terminals", () => {
    expect(tuiInputModeRestoreSequence({ kittyKeyboard: true })).toBe(
      '\x1b[>1u\x1b[?2004h\x1b[?25l',
    );
  });
});

describe('supportsTerminalJobControl', () => {
  it.each([
    { platform: 'win32', expected: false },
    { platform: 'darwin', expected: true },
    { platform: 'linux', expected: true },
  ] as const)('returns $expected on $platform', ({ platform, expected }) => {
    expect(supportsTerminalJobControl(platform)).toBe(expected);
  });
});

describe('installTerminalRestoreOnExit', () => {
  it('registers a process exit listener and removes it on dispose', () => {
    const on = vi.spyOn(process, 'on').mockReturnThis();
    const off = vi.spyOn(process, 'off').mockReturnThis();

    const dispose = installTerminalRestoreOnExit();
    const listener = on.mock.calls[0]?.[1];

    expect(on).toHaveBeenCalledWith('exit', expect.any(Function));
    dispose();
    expect(off).toHaveBeenCalledWith('exit', listener);
  });

  it('tolerates double dispose', () => {
    vi.spyOn(process, 'on').mockReturnThis();
    const off = vi.spyOn(process, 'off').mockReturnThis();
    const dispose = installTerminalRestoreOnExit();
    dispose();
    dispose();
    expect(off).toHaveBeenCalledTimes(2);
  });
});
