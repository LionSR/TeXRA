// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RUN_OUTCOME,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createFakePlatform } from '@test/support/FakePlatform';
import { createModuleMocks } from '@test/support/moduleMocks';
import { getDefaultUnavailableToolNames } from '@tools/registry';

// Local file imports
import {
  createStubDesktopAgentExecutionHost,
  disposeAfterTest,
  makeFakeTrace,
  type RunExecutionRequest,
} from './desktopAgentExecutionTestHarness.ts';
import { loadSourceModule } from './loadSourceModule.ts';

type DesktopExecution = {
  handleExecute(message: unknown): Promise<void>;
  dispose(): void;
};

const mocks = createModuleMocks();

function prepareValidRequest(): (message: unknown) => unknown {
  return vi.fn(() => ({
    valid: true,
    request: { agentName: 'default', filePath: 'main.tex', prompt: 'run' },
  }));
}

function makeOpener() {
  return {
    openPath: vi.fn(async (_filePath: string) => {}),
    openBuildDisplay: vi.fn(async (_location: { absolutePath: string }) => {}),
  };
}

// The mock run bridges a trace into the process session's onResult channel
// (matching AgentLaunchContext.attachRunTrace) and emits a terminal result —
// exactly what the lifecycle does after persisting firstRunDone.
function runAgentEmittingResult(result: {
  outcome: RunOutcome;
  executionId: string;
  streamId: string;
}): RunExecutionRequest {
  return vi.fn(async (_request, options) => {
    const trace = makeFakeTrace();
    options.session.attachRunTrace(trace, result.streamId);
    trace.emit({
      type: 'result',
      outcome: result.outcome,
      executionId: result.executionId,
      streamId: result.streamId,
      agentName: 'proofreader',
      category: 'workflow',
      isSubagent: false,
    });
  });
}

async function createExecution(options: {
  postToRenderer?: (message: unknown) => void;
  opener?: {
    openPath(filePath: string): Promise<void>;
    openBuildDisplay?(location: { absolutePath: string }): Promise<void>;
  };
  showErrorMessage?: (message: string) => Promise<void> | void;
  resolveTeamLaunch?: (...args: unknown[]) => Promise<unknown>;
  prepareMainViewExecutionRequest: (message: unknown) => unknown;
  runAgent?: RunExecutionRequest;
  onRunCompleted?: () => void;
  transcriptOpenError?: Error;
  presentationSignal?: AbortSignal;
  inspectSession?: (session: SessionHandle) => void;
  detectWaitingStreams?: ReturnType<typeof vi.fn>;
}): Promise<DesktopExecution> {
  vi.resetModules();
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform());
  mocks.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData: vi.fn(async () => null),
  }));
  mocks.doMock('@agent/runtime/executeAgent', () => ({
    resumeToolUseFromResumeData: vi.fn(async () => {}),
    // `resumeQueuedToolUse` narrows admission cancellation by `instanceof`
    // against this module's error; the stubbed launcher never throws one, so a
    // stand-in class keeps that branch false.
    ResumeAdmissionCancelledError: class extends Error {},
  }));
  mocks.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(async () => {}),
  }));
  mocks.doMock('@agent/storage/detectWaitingStreams', () => ({
    detectWaitingStreams:
      options.detectWaitingStreams ?? vi.fn(async () => new Set()),
  }));
  if (options.resolveTeamLaunch) {
    mocks.doMock('@common/teams/TeamPlan', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@common/teams/TeamPlan')>()),
      resolveTeamLaunch: options.resolveTeamLaunch,
    }));
  }
  mocks.doMock('@common/storage/KVStore', () => ({
    KVStore: class {
      async read(): Promise<undefined> {
        return undefined;
      }

      async write(): Promise<void> {}

      async delete(): Promise<void> {}

      async deleteDir(): Promise<void> {}

      async exists(): Promise<boolean> {
        return false;
      }

      async listKeys(): Promise<string[]> {
        if (options.transcriptOpenError) throw options.transcriptOpenError;
        return [];
      }
    },
  }));
  mocks.doMock('@controllers/mainView/MainViewExecutionController', () => ({
    prepareMainViewExecutionRequest: options.prepareMainViewExecutionRequest,
    prepareMainViewTeamExecutionRequest: vi.fn(),
  }));
  const { createDesktopAgentExecution } = await loadSourceModule(
    '@desktop/main/desktopAgentExecution',
  );
  const { StreamLogStore, StreamSnapshotStore } = await import('@transcript');
  const { SessionHandle } = await import('@agent/runtime/SessionHandle');
  const { initializeDesktopProcessStores } =
    await import('@desktop/main/desktopProcessStores');
  const transcripts = await StreamLogStore.open();
  const progressSnapshotStore = new StreamSnapshotStore();
  const session = new SessionHandle({
    transcripts,
    snapshots: progressSnapshotStore,
    restartRepair: 'deferred',
  });
  options.inspectSession?.(session);
  const processStores = await initializeDesktopProcessStores(session);
  await session.waitUntilReady();
  let execution: DesktopExecution;
  try {
    execution = await createDesktopAgentExecution({
      postToRenderer: options.postToRenderer ?? vi.fn(),
      session,
      sessionStores: processStores.stores,
      presentationSignal: options.presentationSignal,
      host: createStubDesktopAgentExecutionHost({
        ...(options.opener?.openPath
          ? { openPath: options.opener.openPath }
          : {}),
        ...(options.opener?.openBuildDisplay
          ? { openBuildDisplay: options.opener.openBuildDisplay }
          : {}),
        ...(options.showErrorMessage
          ? { showErrorMessage: options.showErrorMessage }
          : {}),
        ...(options.onRunCompleted
          ? { onRunCompleted: options.onRunCompleted }
          : {}),
      }),
    });
  } catch (error) {
    processStores.dispose();
    session.dispose();
    throw error;
  }
  disposeAfterTest({
    dispose: () => {
      execution.dispose();
      processStores.dispose();
      session.dispose();
    },
  });
  return execution;
}

describe('createDesktopAgentExecution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never attaches a presentation when its window closes during repair', async () => {
    const controller = new AbortController();
    const loadGate = createDeferred();
    const detectionStarted = createDeferred();
    const attached = vi.fn();
    const detached = vi.fn();
    const detectWaitingStreams = vi.fn(async () => {
      detectionStarted.resolve();
      await loadGate.promise;
      return new Set<StreamTabId>();
    });
    const creation = createExecution({
      presentationSignal: controller.signal,
      prepareMainViewExecutionRequest: vi.fn(),
      detectWaitingStreams,
      inspectSession: (session) => {
        const useHostInteractions = session.useHostInteractions.bind(session);
        vi.spyOn(session, 'useHostInteractions').mockImplementation(
          (interactions) => {
            attached();
            const detach = useHostInteractions(interactions);
            return () => {
              detached();
              detach();
            };
          },
        );
      },
    });

    await detectionStarted.promise;
    expect(detectWaitingStreams).toHaveBeenCalledOnce();
    controller.abort();
    expect(attached).not.toHaveBeenCalled();
    expect(detached).not.toHaveBeenCalled();

    loadGate.resolve();
    await expect(creation).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails process-session initialization when persistent transcripts cannot be opened', async () => {
    const failure = new Error('desktop transcript storage unavailable');

    await expect(
      createExecution({
        transcriptOpenError: failure,
        prepareMainViewExecutionRequest: vi.fn(),
      }),
    ).rejects.toBe(failure);
  });

  it('surfaces invalid execution requests through the host error path', async () => {
    const postToRenderer = vi.fn();
    const showErrorMessage = vi.fn();
    const runAgent = vi.fn(async () => {});
    const execution = await createExecution({
      postToRenderer,
      showErrorMessage,
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'Select an input file first.',
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Select an input file first.',
    );
    expect(postToRenderer).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('surfaces team launch errors through the host error path', async () => {
    const showErrorMessage = vi.fn();
    const execution = await createExecution({
      showErrorMessage,
      resolveTeamLaunch: vi.fn(async () => {
        throw new Error('catalog unavailable');
      }),
      prepareMainViewExecutionRequest: vi.fn(),
    });

    await expect(
      execution.handleExecute({
        command: 'execute',
        session: { launchTarget: 'team', teamId: 'physicist' },
      }),
    ).resolves.toBeUndefined();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Team launch failed: catalog unavailable',
    );
  });

  it('lets runtime execution errors propagate to the IPC error handler', async () => {
    const failure = new Error('execution failed');
    const execution = await createExecution({
      runAgent: vi.fn(async () => {
        throw failure;
      }),
      prepareMainViewExecutionRequest: prepareValidRequest(),
    });

    await expect(
      execution.handleExecute({ command: 'execute' }),
    ).rejects.toThrow(failure);
  });

  it('passes remote agent launches to the shared runtime unchanged', async () => {
    const request = {
      agentName: 'remote:remoteWriter',
      filePath: 'main.tex',
      prompt: 'draft',
    };
    const runAgent = vi.fn(async () => {});
    const execution = await createExecution({
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request,
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(runAgent).toHaveBeenCalledWith(
      { kind: 'fresh', ...request },
      expect.objectContaining({
        openWorkflowOutput: expect.any(Function),
        runtimeUnavailableTools: getDefaultUnavailableToolNames('desktop'),
      }),
    );
  });

  it('opens workflow outputs through the desktop preview host', async () => {
    const opener = makeOpener();
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [{ absolutePath: '/tmp/result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      opener,
      runAgent,
      prepareMainViewExecutionRequest: prepareValidRequest(),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(opener.openPath).toHaveBeenCalledWith('/tmp/result.pdf');
  });

  it('replays one workflow output open when its window closes before completion', async () => {
    let session!: SessionHandle;
    const runStarted = createDeferred();
    const runGate = createDeferred();
    const runAgent = vi.fn(async (_request, options) => {
      runStarted.resolve();
      await runGate.promise;
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [{ absolutePath: '/tmp/headless-result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      inspectSession: (value) => {
        session = value;
      },
      runAgent,
      prepareMainViewExecutionRequest: prepareValidRequest(),
    });

    const run = execution.handleExecute({ command: 'execute' });
    await runStarted.promise;
    execution.dispose();
    runGate.resolve();
    await run;

    const firstEmit = vi.fn();
    const detach = session.useHostInteractions({
      emit: firstEmit,
      cancel: vi.fn(),
    });
    await Promise.resolve();
    expect(firstEmit).toHaveBeenCalledOnce();
    expect(firstEmit).toHaveBeenCalledWith('requestOpenFile', {
      location: {
        kind: 'external',
        absolutePath: '/tmp/headless-result.pdf',
      },
      preserveFocus: false,
    });

    detach();
    const secondEmit = vi.fn();
    session.useHostInteractions({ emit: secondEmit, cancel: vi.fn() });
    await Promise.resolve();
    expect(secondEmit).not.toHaveBeenCalled();
  });

  it('fires onRunCompleted when a run reaches a completed terminal result', async () => {
    const onRunCompleted = vi.fn();
    const execution = await createExecution({
      runAgent: runAgentEmittingResult({
        outcome: RUN_OUTCOME.COMPLETED,
        executionId: 'ec1001',
        streamId: 'stream-1',
      }),
      onRunCompleted,
      prepareMainViewExecutionRequest: prepareValidRequest(),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(onRunCompleted).toHaveBeenCalledOnce();
  });

  it('does not fire onRunCompleted on a failed terminal result', async () => {
    const onRunCompleted = vi.fn();
    const execution = await createExecution({
      runAgent: runAgentEmittingResult({
        outcome: RUN_OUTCOME.FAILED,
        executionId: 'exec-2',
        streamId: 'stream-2',
      }),
      onRunCompleted,
      prepareMainViewExecutionRequest: prepareValidRequest(),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it('does not auto-open outputs of a non-completed workflow', async () => {
    const opener = makeOpener();
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.CANCELLED,
        outputs: [{ absolutePath: '/tmp/result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      opener,
      runAgent,
      prepareMainViewExecutionRequest: prepareValidRequest(),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(opener.openPath).not.toHaveBeenCalled();
  });
});
