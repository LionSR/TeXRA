import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Effect } from 'effect';
import { createSessionExitController } from '@cli/chat/tui/sessionExitController';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import type { RunId } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { DisposableStore } from '@texra/platform/disposable';
import { bindTestSessionView } from './fixtures/sessionViewFixture';

const mocks = vi.hoisted(() => ({
  handOffCliShutdownSignalHandlers: vi.fn(),
  cliPlatformShutdownSequence: vi.fn(),
  writeTextStderrAndWait: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@cli/runtime/cliContext', () => ({
  readCliCwd: () => '/tmp/project',
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  handOffCliShutdownSignalHandlers: mocks.handOffCliShutdownSignalHandlers,
  cliPlatformShutdownSequence: mocks.cliPlatformShutdownSequence,
  runCliExit: (exit: Effect.Effect<void, unknown>) => Effect.runPromise(exit),
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderrAndWait: mocks.writeTextStderrAndWait,
  writeTextStdout: mocks.writeTextStdout,
}));

vi.mock('@cli/tui/terminalCleanup', () => ({
  supportsTerminalJobControl: () => false,
}));

describe('chat TUI session exit controller', () => {
  beforeAll(bindTestSessionView);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cliPlatformShutdownSequence.mockReturnValue(Effect.void);
    mocks.writeTextStderrAndWait.mockReturnValue(Effect.void);
  });

  function createController(session: TuiSession) {
    const terminal = { suspend: vi.fn(), resume: vi.fn(), release: vi.fn() };
    const controller = createSessionExitController({
      ink: {
        clear: vi.fn(),
        repaint: vi.fn(),
        rerender: vi.fn(),
        unmount: vi.fn(),
        waitUntilExit: vi.fn(),
        waitUntilRenderFlush: vi.fn(),
        cleanup: vi.fn(),
      },
      session,
      commandName: 'texra',
      cwd: '/tmp/project',
      disposables: new DisposableStore(),
      terminal,
      runtime: testRuntime(),
      submitted: Effect.void,
      getApprovalPolicy: () => 'ask',
      flushArtifacts: Effect.fail(new Error('disk full')),
      repaintAfterTerminalResume: vi.fn(),
      interruptActive: vi.fn(),
      quiet: false,
    });
    return { controller, terminal };
  }

  it('restores the terminal and prints the hint when the graceful flush fails', async () => {
    const session = new TuiSession();
    session.runId = 'exec-graceful-flush' as RunId;
    const { controller, terminal } = createController(session);

    await controller.gracefulTeardown();

    expect(mocks.writeTextStderrAndWait).toHaveBeenCalledWith(
      expect.stringContaining('Transcript flush failed during exit'),
    );
    expect(terminal.release).toHaveBeenCalledOnce();
    expect(mocks.writeTextStdout).toHaveBeenCalledWith(
      expect.stringContaining('texra resume exec-graceful-flush'),
    );
  });
});
