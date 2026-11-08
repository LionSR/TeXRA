import { writeSync } from 'node:fs';

import { layer } from '@effect/vitest';
import { Layer } from 'effect';
import { afterEach, assert, beforeEach, describe, expect, vi } from 'vitest';

import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';

import { startChat } from '@cli/chat/tui/state/cliState';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { installTerminalTitleUpdates } from '@cli/chat/tui/terminalTitle';
import { SessionGraph } from '@test/support/testKernel';
import {
  boundTestSessionView,
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
layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('terminal cleanup', (it) => {
  beforeEach(() => seedView(viewWith([])));
  afterEach(() => {
    startChat();
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
      const launched = session.claimLaunch();
      assert(launched !== undefined);
      await Promise.resolve();
      updates.suspend();
      expect(writeSync).not.toHaveBeenCalled();

      terminalCapabilities.set({
        ...NO_TERMINAL_CAPABILITIES,
        oscColorReports: true,
      });
      const capableUpdates = installTerminalTitleUpdates(
        '/tmp/evil\x07\x1b]0;pwned\x07',
      );
      session.endLaunch(launched, { exitCode: CliExitCode.Success });
      await Promise.resolve();
      expect(writeSync).toHaveBeenLastCalledWith(
        1,
        '\x1b]0;{T}·evil]0;pwned\x07',
      );
      capableUpdates.suspend();
    });
  });
});
