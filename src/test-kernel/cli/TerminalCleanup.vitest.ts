import { writeSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import {
  clearApprovals,
  enqueueApproval,
} from '@cli/chat/tui/state/approvalQueue';
import {
  resetCliState,
  rootRunPending,
  rootRunStreamId,
  setStreamStatusInCliState,
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
import { STREAM_PHASE } from '@shared/schemas';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn(),
}));

const NO_TERMINAL_CAPABILITIES = {
  kittyKeyboard: false,
  graphemeClusters: false,
  bracketedPaste: false,
  oscColorReports: false,
  discovered: false,
};

afterEach(() => {
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
    payload: {
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
      'TeXRA — coauthor',
    );
  });

  it('falls back to the bare brand name at the filesystem root', () => {
    expect(terminalTitleText('/')).toBe('TeXRA');
  });

  it('adds running and approval labels before the project name', () => {
    expect(terminalTitleText('/Users/ray/projects/coauthor', 'running')).toBe(
      'TeXRA — Running — coauthor',
    );
    expect(terminalTitleText('/Users/ray/projects/coauthor', 'approval')).toBe(
      'TeXRA — Approval needed — coauthor',
    );
    expect(terminalTitleText('/', 'running')).toBe('TeXRA — Running');
  });

  it('strips control characters out of a hostile folder name', () => {
    expect(terminalTitleText('/tmp/evil\x07\x1b]0;pwned\x07')).toBe(
      'TeXRA — evil]0;pwned',
    );
  });
});

describe('installTerminalTitleUpdates', () => {
  const enableOscTitles = (): void => {
    terminalCapabilities.set({
      ...NO_TERMINAL_CAPABILITIES,
      oscColorReports: true,
      discovered: true,
    });
  };
  const flushTitleUpdate = async (): Promise<void> => {
    await Promise.resolve();
  };
  const expectLastTitle = (title: string): void => {
    expect(writeSync).toHaveBeenLastCalledWith(1, `\x1b]0;${title}\x07`);
  };

  it('shows root launch as running before the first stream status arrives', async () => {
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    rootRunPending.set(true);

    await flushTitleUpdate();

    expectLastTitle('TeXRA — - — coauthor');
    updates.dispose();
  });

  it('stays running after the root id is published but before its status arrives', () => {
    enableOscTitles();
    rootRunPending.set(true);
    rootRunStreamId.set('status-pending-root');

    const updates = installTerminalTitleUpdates('/work/coauthor');

    expectLastTitle('TeXRA — - — coauthor');
    updates.dispose();
  });

  it('uses every stream phase and gives queued approval precedence', async () => {
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    rootRunPending.set(true);
    rootRunStreamId.set('transition-root');
    setStreamStatusInCliState({
      streamId: 'transition-root',
      status: STREAM_PHASE.WAITING,
    });
    setStreamStatusInCliState({
      streamId: 'transition-child',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();
    expectLastTitle('TeXRA — - — coauthor');

    queueTitleApproval('title-transition');
    await flushTitleUpdate();
    expectLastTitle('TeXRA — Approval needed — coauthor');

    clearApprovals();
    await flushTitleUpdate();
    expectLastTitle('TeXRA — - — coauthor');

    setStreamStatusInCliState({
      streamId: 'transition-child',
      status: STREAM_PHASE.WAITING,
    });
    await flushTitleUpdate();
    expectLastTitle('TeXRA — coauthor');
    updates.dispose();
  });

  it('animates running titles and stops the timer outside the running state', async () => {
    vi.useFakeTimers();
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    setStreamStatusInCliState({
      streamId: 'animated-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    expectLastTitle('TeXRA — - — coauthor');
    vi.advanceTimersByTime(500);
    expectLastTitle('TeXRA — / — coauthor');
    vi.advanceTimersByTime(500);
    expectLastTitle('TeXRA — \\ — coauthor');

    queueTitleApproval('animated-root');
    await flushTitleUpdate();
    expectLastTitle('TeXRA — Approval needed — coauthor');
    const writesWhileApprovalNeeded = vi.mocked(writeSync).mock.calls.length;
    vi.advanceTimersByTime(1_500);
    expect(writeSync).toHaveBeenCalledTimes(writesWhileApprovalNeeded);

    clearApprovals();
    await flushTitleUpdate();
    expectLastTitle('TeXRA — - — coauthor');
    updates.suspend();
    expectLastTitle('TeXRA — coauthor');
    const writesWhileSuspended = vi.mocked(writeSync).mock.calls.length;
    vi.advanceTimersByTime(1_500);
    expect(writeSync).toHaveBeenCalledTimes(writesWhileSuspended);

    updates.resume();
    expectLastTitle('TeXRA — - — coauthor');
    setStreamStatusInCliState({
      streamId: 'animated-root',
      status: STREAM_PHASE.WAITING,
    });
    await flushTitleUpdate();
    expectLastTitle('TeXRA — coauthor');
    const writesWhileIdle = vi.mocked(writeSync).mock.calls.length;
    vi.advanceTimersByTime(1_500);
    expect(writeSync).toHaveBeenCalledTimes(writesWhileIdle);

    setStreamStatusInCliState({
      streamId: 'animated-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();
    expectLastTitle('TeXRA — - — coauthor');
    updates.dispose();
    const writesAfterDispose = vi.mocked(writeSync).mock.calls.length;
    vi.advanceTimersByTime(1_500);
    expect(writeSync).toHaveBeenCalledTimes(writesAfterDispose);
  });

  it('deduplicates unchanged title projections and resets an active title on teardown', async () => {
    enableOscTitles();
    const on = vi.spyOn(process, 'on');
    const off = vi.spyOn(process, 'off');
    const updates = installTerminalTitleUpdates('/work/coauthor');
    const exitListener = on.mock.calls.find(([event]) => event === 'exit')?.[1];
    setStreamStatusInCliState({
      streamId: 'dedup-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();
    setStreamStatusInCliState({
      streamId: 'dedup-child',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    expect(writeSync).toHaveBeenCalledTimes(2);
    updates.dispose();
    expect(writeSync).toHaveBeenCalledTimes(3);
    expectLastTitle('TeXRA — coauthor');
    expect(off).toHaveBeenCalledWith('exit', exitListener);
  });

  it('restores the idle title from the process-exit path', async () => {
    enableOscTitles();
    const on = vi.spyOn(process, 'on');
    const updates = installTerminalTitleUpdates('/work/coauthor');
    const exitListener = on.mock.calls.find(
      ([event]) => event === 'exit',
    )?.[1] as ((code: number) => void) | undefined;
    setStreamStatusInCliState({
      streamId: 'exit-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    exitListener?.(0);

    expectLastTitle('TeXRA — coauthor');
    expect(writeSync).toHaveBeenCalledTimes(3);
    updates.dispose();
    expect(writeSync).toHaveBeenCalledTimes(3);
  });

  it('shows the idle title while suspended and re-projects live state on resume', async () => {
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    setStreamStatusInCliState({
      streamId: 'suspend-root',
      status: STREAM_PHASE.RUNNING,
    });
    await flushTitleUpdate();

    updates.suspend();
    expectLastTitle('TeXRA — coauthor');
    queueTitleApproval('title-suspend');
    await flushTitleUpdate();
    expect(writeSync).toHaveBeenCalledTimes(3);

    updates.resume();
    expectLastTitle('TeXRA — Approval needed — coauthor');
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
    expectLastTitle('TeXRA — evil]0;pwned');
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
