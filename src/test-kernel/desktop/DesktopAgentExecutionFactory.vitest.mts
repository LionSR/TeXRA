// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared schemas and tools
import { RUN_OUTCOME } from '@shared/schemas';
import { DIAGNOSTICS_ADD_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';

// Local imports - desktop test support
import {
  disposeAfterTest,
  makeFakeTrace,
  mockLoggerModule,
  type DesktopAgentExecutionModule,
  type RunExecutionRequest,
} from './desktopAgentExecutionTestHarness.mjs';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type DesktopExecution = {
  handleExecute(message: unknown): Promise<void>;
  progress: {
    openFileCompile(filePath: string): Promise<void>;
  };
  dispose(): void;
};

async function createExecution(options: {
  postToRenderer?: (message: unknown) => void;
  opener?: {
    openPath(filePath: string): Promise<void>;
    openBuildDisplay?(location: { absolutePath: string }): Promise<void>;
  };
  showErrorMessage?: (message: string) => Promise<void> | void;
  prepareMainViewExecutionRequest: (message: unknown) => unknown;
  runAgent?: RunExecutionRequest;
  onRunCompleted?: () => void;
}): Promise<DesktopExecution> {
  vi.resetModules();
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform());
  vi.doMock('@agent/runtime/ProgressViewBridge', () => ({
    setProgressViewBridge: vi.fn(),
  }));
  vi.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData: vi.fn(async () => null),
  }));
  vi.doMock('@agent/runtime/executeAgent', () => ({
    resumeToolUseFromSnapshot: vi.fn(async () => {}),
  }));
  vi.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(async () => {}),
  }));
  vi.doMock('@common/storage/KVStore', () => ({
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
        return [];
      }
    },
  }));
  vi.doMock('@controllers/mainView/MainViewExecutionController', () => ({
    prepareMainViewExecutionRequest: options.prepareMainViewExecutionRequest,
  }));
  mockLoggerModule();
  const { createDesktopAgentExecution } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  return disposeAfterTest(
    createDesktopAgentExecution({
      postToRenderer: options.postToRenderer ?? vi.fn(),
      opener: options.opener,
      showErrorMessage: options.showErrorMessage,
      onRunCompleted: options.onRunCompleted,
    }),
  );
}

describe('createDesktopAgentExecution', () => {
  afterEach(() => {
    vi.doUnmock('@agent/runtime/ProgressViewBridge');
    vi.doUnmock('@agent/runtime/SessionResumeRetrieval');
    vi.doUnmock('@agent/runtime/executeAgent');
    vi.doUnmock('@agent/runtime/runAgent');
    vi.doUnmock('@common/storage/KVStore');
    vi.doUnmock('@controllers/mainView/MainViewExecutionController');
    vi.doUnmock('@logger');
    vi.restoreAllMocks();
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

  it('lets runtime execution errors propagate to the IPC error handler', async () => {
    const failure = new Error('execution failed');
    const execution = await createExecution({
      runAgent: vi.fn(async () => {
        throw failure;
      }),
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
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
      request,
      expect.objectContaining({
        openWorkflowOutput: expect.any(Function),
        runtimeUnavailableTools: [
          ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
          'inline_comment',
          DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
        ],
      }),
    );
  });

  it('opens workflow outputs through the desktop preview host', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [{ absolutePath: '/tmp/result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      opener,
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(opener.openPath).toHaveBeenCalledWith('/tmp/result.pdf');
  });

  it('fires onRunCompleted when a run reaches a completed terminal result', async () => {
    const onRunCompleted = vi.fn();
    // The mock run bridges a trace into the window session's onResult channel
    // (mirroring AgentLaunchContext.attachRunTrace) and emits a completed
    // result — exactly what the lifecycle does after persisting firstRunDone.
    const runAgent = vi.fn(async (_request, options) => {
      const trace = makeFakeTrace();
      options.session.attachRunTrace(trace, 'stream-1');
      trace.emit({
        type: 'result',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId: 'ec1001',
        streamId: 'stream-1',
        agentName: 'proofreader',
        category: 'workflow',
        isSubagent: false,
      });
    });
    const execution = await createExecution({
      runAgent,
      onRunCompleted,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(onRunCompleted).toHaveBeenCalledOnce();
  });

  it('does not fire onRunCompleted on a failed terminal result', async () => {
    const onRunCompleted = vi.fn();
    const runAgent = vi.fn(async (_request, options) => {
      const trace = makeFakeTrace();
      options.session.attachRunTrace(trace, 'stream-2');
      trace.emit({
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
        executionId: 'exec-2',
        streamId: 'stream-2',
        agentName: 'proofreader',
        category: 'workflow',
        isSubagent: false,
      });
    });
    const execution = await createExecution({
      runAgent,
      onRunCompleted,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it('does not auto-open outputs of a non-completed workflow', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.CANCELLED,
        outputs: [{ absolutePath: '/tmp/result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      opener,
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(opener.openPath).not.toHaveBeenCalled();
  });

  it('opens compile-file actions through the desktop preview host', async () => {
    const opener = {
      openPath: vi.fn(async (_filePath: string) => {}),
      openBuildDisplay: vi.fn(
        async (_location: { absolutePath: string }) => {},
      ),
    };
    const execution = await createExecution({
      opener,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'not used',
      })),
    });

    await execution.progress.openFileCompile('/tmp/output.tex');
    expect(opener.openBuildDisplay).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: '/tmp/output.tex' }),
    );
    expect(opener.openPath).not.toHaveBeenCalled();
  });

  it('does not fall back to plain file open for compile-file actions', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const showErrorMessage = vi.fn();
    const execution = await createExecution({
      opener,
      showErrorMessage,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'not used',
      })),
    });

    await execution.progress.openFileCompile('/tmp/output.tex');
    expect(opener.openPath).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Desktop LaTeX preview is unavailable. Cannot compile and open this file.',
    );
  });
});
