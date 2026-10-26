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

import { Effect } from 'effect';
import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';

import { resetCliState, rootRunId } from '@cli/chat/tui/state/cliState';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { acquireTuiTerminal } from '@cli/tui/terminalCleanup';
import { installTerminalTitleUpdates } from '@cli/chat/tui/terminalTitle';
import { type RunPhase, type RunId } from '@shared/schemas';
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
  it('keeps sanitization and the OSC capability gate across live transitions', async () => {
    const updates = installTerminalTitleUpdates(
      '/tmp/evil\x07\x1b]0;pwned\x07',
    );
    const session = new TuiSession();
    session.markRunPending(Effect.never);
    await flushTitleUpdate();
    updates.dispose();
    expect(writeSync).not.toHaveBeenCalled();

    enableOscTitles();
    const capableUpdates = installTerminalTitleUpdates(
      '/tmp/evil\x07\x1b]0;pwned\x07',
    );
    session.clearRunState();
    await flushTitleUpdate();
    expectLastTitle('{T}·evil]0;pwned');
    capableUpdates.dispose();
  });
});

describe('acquireTuiTerminal resume', () => {
  const resumeWith = (kittyKeyboard: boolean): void => {
    const title = { suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn() };
    const terminal = acquireTuiTerminal({ kittyKeyboard, title });
    terminal.resume();
    terminal.release();
    expect(title.resume).toHaveBeenCalledOnce();
  };

  it("re-pushes Ink's kitty disambiguate flag on kitty terminals", () => {
    resumeWith(true);

    expect(writeSync).toHaveBeenCalledWith(1, '\x1b[>1u\x1b[?2004h\x1b[?25l');
  });
});
