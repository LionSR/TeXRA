import PQueue from 'p-queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionExitController } from '@cli/chat/tui/sessionExitController';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { DisposableStore } from '@platform/disposable';

const mocks = vi.hoisted(() => ({
  cleanupTerminalModes: vi.fn(),
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
  cleanupTerminalModes: mocks.cleanupTerminalModes,
  restoreTuiInputModes: vi.fn(),
  supportsTerminalJobControl: () => false,
}));

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    createLog: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@platform/platform', () => ({
  platform: () => ({ lifecycle: {} }),
}));

describe('chat TUI session exit controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runCliPlatformShutdownSequence.mockResolvedValue(undefined);
  });

  it('prints an artifact flush failure during signal teardown despite quiet logging', async () => {
    const session = new TuiSession();
    session.executionId = 'exec-flush-warning';
    session.runExitCode = CliExitCode.Success;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      return undefined as never;
    }) as typeof process.exit);
    let finishStderrWrite: (() => void) | undefined;
    const stderrWrite = new Promise<void>((resolve) => {
      finishStderrWrite = resolve;
    });
    mocks.writeTextStderrAndWait.mockReturnValue(stderrWrite);
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
      canResume: true,
      clearItermProgress: false,
      kittyKeyboardEnabled: false,
      disposables: new DisposableStore(),
      disposeTerminalRestoreOnExit: vi.fn(),
      followUpQueue: new PQueue(),
      getApprovalPolicy: () => 'ask',
      flushArtifacts: vi.fn().mockRejectedValue(new Error('disk full')),
      repaintAfterTerminalResume: vi.fn(),
      suspendTerminalTitle: vi.fn(),
      resumeTerminalTitle: vi.fn(),
      canStopActiveRun: () => false,
      isResumableIdle: () => true,
      interruptActive: vi.fn(),
    });

    try {
      controller.handleSigint();
      await vi.waitFor(() =>
        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledOnce(),
      );

      expect(mocks.writeTextStdout).toHaveBeenCalledWith(
        expect.stringContaining('texra resume exec-flush-warning'),
      );
      expect(mocks.writeTextStderrAndWait).toHaveBeenCalledWith(
        expect.stringContaining(
          'Transcript flush failed during signal exit; the session tail may be missing: disk full',
        ),
      );
      expect(mocks.runCliPlatformShutdownSequence).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      finishStderrWrite?.();
      await vi.waitFor(() =>
        expect(exit).toHaveBeenCalledWith(CliExitCode.Success),
      );
    } finally {
      exit.mockRestore();
    }
  });
});
