import '@test/support/defaultSessionTestSetup';

import { writeSync } from 'node:fs';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';

import {
  claimedRunId,
  resetCliState,
  rootRunPending,
  rootRunId,
} from '@cli/chat/tui/state/cliState';
import {
  installTerminalRestoreOnExit,
  restoreTuiInputModes,
  supportsTerminalJobControl,
} from '@cli/tui/terminalCleanup';
import {
  installTerminalTitleUpdates,
  terminalTitleText,
} from '@cli/chat/tui/terminalTitle';
import { RUN_PHASE, type RunPhase, type RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn(),
}));

const NO_TERMINAL_CAPABILITIES = {
  kittyKeyboard: false,
  oscColorReports: false,
};

/** The fold's output the title reads: one root, every later run its
 *  child, and the session's pending requests. */
const phases = new Map<RunId, RunPhase>();
let requests: SessionView['requests'] = [];
function syncView(): void {
  const ids = [...phases.keys()];
  const rootId = ids[0];
  const runs = [...phases].map(([id, status], index) =>
    makeRunView({
      id,
      status,
      ...(index > 0 && rootId !== undefined
        ? { parentId: rootId, ancestors: [{ id: rootId, label: rootId }] }
        : {}),
    }),
  );
  if (rootId !== undefined) rootRunId.set(rootId);
  seedView(viewWith(runs, { requests }));
}
function setPhase(runId: string, status: RunPhase): void {
  phases.set(runId as RunId, status);
  syncView();
}
beforeAll(bindTestSessionView);
beforeEach(() => {
  phases.clear();
  requests = [];
  syncView();
});
afterEach(() => {
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

/** Put one real request in the queue: the title reads the queue's own
 *  projection, so the test has to drive it through the queue. */
function queueTitleApproval(label: string): void {
  const runId = label as RunId;
  requests = [
    ...requests,
    {
      runId,
      requestId: `title-${runId}`,
      payload: {
        kind: 'bash',
        data: {
          requestId: `title-${runId}`,
          allowBypass: true,
          runId,
          command: 'echo ok',
        },
      },
      thread: null,
    },
  ];
  syncView();
}
function clearTitleApprovals(): void {
  requests = [];
  syncView();
}

describe('terminalTitleText', () => {
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

  it('shows root launch as running before the first run status arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    rootRunPending.set(true);

    await flushTitleUpdate();

    expectLastTitle('⠋ {T}·coauthor');
    updates.dispose();
  });

  it('uses every run phase and gives queued approval precedence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    rootRunPending.set(true);
    claimedRunId.set('transition-root' as RunId);
    setPhase('transition-root', RUN_PHASE.WAITING);
    setPhase('transition-child', RUN_PHASE.RUNNING);
    await flushTitleUpdate();
    expectLastTitle('⠋ {T}·coauthor');

    queueTitleApproval('title-transition');
    await flushTitleUpdate();
    expectLastTitle('⚠ {T}·coauthor');

    clearTitleApprovals();
    await flushTitleUpdate();
    expectLastTitle('⠋ {T}·coauthor');

    setPhase('transition-child', RUN_PHASE.WAITING);
    await flushTitleUpdate();
    expectLastTitle('{T}·coauthor');
    updates.dispose();
  });

  it('returns to idle when only the canonical run phase changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    enableOscTitles();
    const updates = installTerminalTitleUpdates('/work/coauthor');
    setPhase('status-only-root', RUN_PHASE.RUNNING);
    await flushTitleUpdate();
    expectLastTitle('⠋ {T}·coauthor');

    // The canonical phase is the fold's: the title reads the view the status
    // bar reads, and nothing else changes.
    setPhase('status-only-root', RUN_PHASE.WAITING);
    await flushTitleUpdate();

    expectLastTitle('{T}·coauthor');
    expectNoTitleWrites();
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

describe('restoreTuiInputModes', () => {
  it('re-arms bracketed paste and cursor hide after a SIGCONT resume', () => {
    restoreTuiInputModes({ kittyKeyboard: false });

    expect(writeSync).toHaveBeenLastCalledWith(1, '\x1b[?2004h\x1b[?25l');
  });

  it("re-pushes Ink's kitty disambiguate flag on kitty terminals", () => {
    restoreTuiInputModes({ kittyKeyboard: true });

    expect(writeSync).toHaveBeenLastCalledWith(
      1,
      '\x1b[>1u\x1b[?2004h\x1b[?25l',
    );
  });
});
