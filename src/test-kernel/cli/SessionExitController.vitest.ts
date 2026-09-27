import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Effect } from 'effect';
import { createSessionExitController } from '@cli/chat/tui/sessionExitController';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { DisposableStore } from '@platform/disposable';
import type { RunId } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import { bindTestSessionView } from './fixtures/sessionViewFixture';

const mocks = vi.hoisted(() => ({
  handOffCliShutdownSignalHandlers: vi.fn(),
  runCliPlatformShutdownSequence: vi.fn(),
  writeTextStderrAndWait: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@cli/runtime/cliContext', () => ({
  readCliCwd: () => '/tmp/project',
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  handOffCliShutdownSignalHandlers: mocks.handOffCliShutdownSignalHandlers,
  runCliPlatformShutdownSequence: mocks.runCliPlatformShutdownSequence,
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
    mocks.runCliPlatformShutdownSequence.mockResolvedValue(undefined);
    mocks.writeTextStderrAndWait.mockResolvedValue(undefined);
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
      followUpsIdle: Effect.void,
      getApprovalPolicy: () => 'ask',
      flushArtifacts: Effect.fail(new Error('disk full')),
      repaintAfterTerminalResume: vi.fn(),
      interruptActive: vi.fn(),
    });
    return { controller, terminal };
  }

  it('prints an artifact flush failure during signal teardown despite quiet logging', async () => {
    const session = new TuiSession(() => undefined);
    session.runId = 'exec-flush-warning' as RunId;
    session.runExitCode = CliExitCode.Success;
    const exitCalled = createDeferred();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      exitCalled.resolve();
      return undefined as never;
    }) as typeof process.exit);
    let finishStderrWrite: (() => void) | undefined;
    const stderrWrite = new Promise<void>((resolve) => {
      finishStderrWrite = resolve;
    });
    const stderrWaitCalled = createDeferred();
    mocks.writeTextStderrAndWait.mockImplementationOnce(() => {
      stderrWaitCalled.resolve();
      return stderrWrite;
    });
    vi.spyOn(session, 'isResumableIdle').mockReturnValue(true);
    const { controller } = createController(session);

    try {
      controller.handleSigint();
      await stderrWaitCalled.promise;
      expect(mocks.writeTextStderrAndWait).toHaveBeenCalledOnce();

      expect(mocks.writeTextStdout).toHaveBeenCalledWith(
        expect.stringContaining('texra resume exec-flush-warning'),
      );
      expect(mocks.writeTextStderrAndWait).toHaveBeenCalledWith(
        expect.stringContaining(
          'Transcript flush failed during exit; the session tail may be missing: disk full',
        ),
      );
      expect(mocks.runCliPlatformShutdownSequence).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      finishStderrWrite?.();
      await exitCalled.promise;
      expect(exit).toHaveBeenCalledWith(CliExitCode.Success);
    } finally {
      exit.mockRestore();
    }
  });

  it('restores the terminal and prints the hint when the graceful flush fails', async () => {
    const session = new TuiSession(() => undefined);
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
