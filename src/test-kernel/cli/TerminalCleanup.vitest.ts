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

import { resetCliState } from '@cli/chat/tui/state/cliState';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { acquireTuiTerminal } from '@cli/tui/terminalCleanup';
import { installTerminalTitleUpdates } from '@cli/chat/tui/terminalTitle';
import {
  bindTestSessionView,
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

// The title reads the fold's output: here, no runs and no requests.
beforeAll(bindTestSessionView);
beforeEach(() => seedView(viewWith([])));
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
  it('keeps sanitization and the OSC capability gate across live transitions', async () => {
    const updates = installTerminalTitleUpdates(
      '/tmp/evil\x07\x1b]0;pwned\x07',
    );
    const session = new TuiSession();
    session.markRunPending(Effect.never);
    await Promise.resolve();
    updates.dispose();
    expect(writeSync).not.toHaveBeenCalled();

    terminalCapabilities.set({
      ...NO_TERMINAL_CAPABILITIES,
      oscColorReports: true,
    });
    const capableUpdates = installTerminalTitleUpdates(
      '/tmp/evil\x07\x1b]0;pwned\x07',
    );
    session.clearRunState();
    await Promise.resolve();
    expect(writeSync).toHaveBeenLastCalledWith(
      1,
      '\x1b]0;{T}·evil]0;pwned\x07',
    );
    capableUpdates.dispose();
  });
});

describe('acquireTuiTerminal resume', () => {
  it("re-pushes Ink's kitty disambiguate flag on kitty terminals", () => {
    const title = { suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn() };
    const terminal = acquireTuiTerminal({ kittyKeyboard: true, title });
    terminal.resume();
    terminal.release();

    expect(writeSync).toHaveBeenCalledWith(1, '\x1b[>1u\x1b[?2004h\x1b[?25l');
  });
});
