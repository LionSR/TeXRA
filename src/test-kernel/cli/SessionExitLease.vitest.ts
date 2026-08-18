// A resumable WAITING flow keeps its persisted cursor but must relinquish its
// process lease before the CLI exits. Otherwise an immediate `texra resume`
// sees a live owner that no longer exists and waits for the stale horizon.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanupTerminalModes: vi.fn(),
  clearTransientNotice: vi.fn(),
  resetCliState: vi.fn(),
  runCliPlatformShutdownSequence: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  handOffCliShutdownSignalHandlers: vi.fn(),
  runCliPlatformShutdownSequence: mocks.runCliPlatformShutdownSequence,
}));
vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStdout: mocks.writeTextStdout,
}));
vi.mock('@platform/platform', () => ({
  platform: () => ({ lifecycle: {} }),
}));
vi.mock('@cli/chat/tui/state/childExecutions', () => ({
  childRosters: { get: () => new Map() },
}));
vi.mock('@cli/chat/tui/state/cliState', () => ({
  clearTransientNotice: mocks.clearTransientNotice,
  registerCliStateResetHook: vi.fn(() => () => undefined),
  resetCliState: mocks.resetCliState,
  setTransientNotice: vi.fn(),
  streams: { get: () => ({}) },
}));
vi.mock('@cli/tui/terminalCleanup', () => ({
  cleanupTerminalModes: mocks.cleanupTerminalModes,
  restoreTuiInputModes: vi.fn(),
  supportsTerminalJobControl: () => false,
}));

import * as executionLease from '@agent/storage/executionLease';
import { createSessionExitController } from '@cli/chat/tui/sessionExitController';
import { DisposableStore } from '@platform/disposable';

describe('CLI session exit lease ownership', () => {
  let completeLeaseSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runCliPlatformShutdownSequence.mockResolvedValue(undefined);
    completeLeaseSpy = vi
      .spyOn(executionLease, 'completeOwnedExecutionLease')
      .mockResolvedValue({ status: 'released' });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as typeof process.exit);
  });

  afterEach(() => {
    completeLeaseSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function controller(options: {
    readonly resumableIdle: boolean;
    readonly flushArtifacts?: () => Promise<void>;
  }) {
    return createSessionExitController({
      ink: { unmount: vi.fn() } as never,
      session: {
        executionId: 'resume-root',
        runCompleted: false,
        runExitCode: 0,
        stopRequested: false,
      } as never,
      commandName: 'texra-local',
      cwd: '/workspace',
      canResume: false,
      clearItermProgress: false,
      kittyKeyboardEnabled: false,
      disposables: new DisposableStore(),
      disposeTerminalRestoreOnExit: vi.fn(),
      followUpQueue: { onIdle: vi.fn().mockResolvedValue(undefined) } as never,
      getApprovalPolicy: () => 'yolo',
      flushArtifacts:
        options.flushArtifacts ?? vi.fn().mockResolvedValue(undefined),
      repaintAfterTerminalResume: vi.fn(),
      suspendTerminalTitle: vi.fn(),
      resumeTerminalTitle: vi.fn(),
      canStopActiveRun: () => false,
      isResumableIdle: () => options.resumableIdle,
      interruptActive: vi.fn(),
    });
  }

  /** Returns an async stub that appends `label` to `order` when invoked. */
  function pushes(order: string[], label: string): () => Promise<void> {
    return async () => {
      order.push(label);
    };
  }

  it('flushes before releasing a resumable idle execution lease', async () => {
    const order: string[] = [];
    const exitController = controller({
      resumableIdle: true,
      flushArtifacts: pushes(order, 'flush'),
    });
    completeLeaseSpy.mockImplementation(async () => {
      order.push('release');
      return { status: 'released' };
    });

    await expect(exitController.gracefulTeardown()).rejects.toThrow(
      'process.exit',
    );

    expect(order).toEqual(['flush', 'release']);
    expect(completeLeaseSpy).toHaveBeenCalledWith('resume-root');
  });

  it('does not release a lease for an ordinary non-resumable exit', async () => {
    await controller({ resumableIdle: false }).gracefulTeardown();

    expect(completeLeaseSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('releases the lease on the resumable-idle signal exit path', async () => {
    const order: string[] = [];
    const exitController = controller({
      resumableIdle: true,
      flushArtifacts: pushes(order, 'flush'),
    });
    completeLeaseSpy.mockImplementation(async () => {
      order.push('release');
      return { status: 'released' };
    });
    mocks.runCliPlatformShutdownSequence.mockImplementation(
      pushes(order, 'shutdown'),
    );
    exitSpy.mockImplementation((() => undefined) as typeof process.exit);

    exitController.handleSigint();

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    expect(order).toEqual(['flush', 'release', 'shutdown']);
  });

  it('still shuts down and exits when signal persistence fails', async () => {
    const order: string[] = [];
    const exitController = controller({
      resumableIdle: true,
      flushArtifacts: async () => {
        order.push('flush');
        throw new Error('flush failed');
      },
    });
    mocks.runCliPlatformShutdownSequence.mockImplementation(
      pushes(order, 'shutdown'),
    );
    exitSpy.mockImplementation((() => undefined) as typeof process.exit);

    exitController.handleSigint();

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    expect(order).toEqual(['flush', 'shutdown']);
    expect(completeLeaseSpy).not.toHaveBeenCalled();
  });
});
