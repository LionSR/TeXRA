// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - progress schemas
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import { AGENT_CATEGORY, STREAM_STATUS } from '@shared/schemas';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type Bridge = {
  dispose(): void;
};

type TestableBridge = Bridge & {
  handleProgressEvent(event: string, payload: unknown): void;
};

type DesktopExecution = {
  handleExecute(message: unknown): Promise<void>;
  dispose(): void;
};

interface DesktopAgentExecutionModule {
  DesktopProgressBridge: new (
    postToRenderer: (message: unknown) => void,
  ) => Bridge;
  createDesktopAgentExecution(options: {
    postToRenderer(message: unknown): void;
    openPath?: (filePath: string) => Promise<void>;
    showInformationMessage?: (message: string) => Promise<void> | void;
  }): DesktopExecution;
}

type ProgressMessage = {
  command?: string;
  streams?: Array<{ name: string; creationTimestamp: number }>;
  streamStates?: Record<string, unknown>;
};

async function createBridge(messages: unknown[]): Promise<TestableBridge> {
  vi.resetModules();
  vi.doMock('@agent/runtime/AgentRuntimeHost', () => ({
    createAgentRuntimeHost: vi.fn(() => ({})),
  }));
  vi.doMock('@agent/runtime/RunStorageService', () => ({
    setRunStorageService: vi.fn(),
  }));
  vi.doMock('@agent/runtime/runExecutionRequest', () => ({
    runValidatedExecutionRequest: vi.fn(),
  }));
  vi.doMock('@common/storage', () => ({
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
    prepareMainViewExecutionRequest: vi.fn(),
  }));
  vi.doMock('@logger/AgentLogger', () => ({
    AgentLogger: class {
      static setStreamLogStore(): void {}
    },
  }));
  vi.doMock('vscode', () => ({
    commands: {
      executeCommand: vi.fn(),
    },
    Disposable: class {
      constructor(private readonly onDispose: () => void = () => undefined) {}

      dispose(): void {
        this.onDispose();
      }

      static from(...disposables: Array<{ dispose(): void }>): {
        dispose(): void;
      } {
        return {
          dispose: () =>
            disposables.forEach((disposable) => disposable.dispose()),
        };
      }
    },
    env: {
      openExternal: vi.fn(),
    },
    FileSystemError: {
      FileNotFound: class extends Error {},
    },
    FileType: {
      File: 1,
      Directory: 2,
      SymbolicLink: 64,
    },
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        path: fsPath,
        toString: () => fsPath,
      }),
      parse: (value: string) => ({
        fsPath: value,
        path: value,
        toString: () => value,
      }),
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        append: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
        show: vi.fn(),
      })),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      fs: {},
      getConfiguration: vi.fn(() => ({
        get: vi.fn(),
        update: vi.fn(),
      })),
      workspaceFolders: [],
    },
  }));
  const { DesktopProgressBridge } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  return new DesktopProgressBridge((message) =>
    messages.push(message),
  ) as TestableBridge;
}

async function createExecution(options: {
  postToRenderer?: (message: unknown) => void;
  showInformationMessage?: (message: string) => Promise<void> | void;
  prepareMainViewExecutionRequest: (message: unknown) => unknown;
  runValidatedExecutionRequest?: () => Promise<void>;
}): Promise<DesktopExecution> {
  vi.resetModules();
  vi.doMock('@agent/runtime/AgentRuntimeHost', () => ({
    createAgentRuntimeHost: vi.fn(() => ({})),
  }));
  vi.doMock('@agent/runtime/RunStorageService', () => ({
    setRunStorageService: vi.fn(),
  }));
  vi.doMock('@agent/runtime/runExecutionRequest', () => ({
    runValidatedExecutionRequest:
      options.runValidatedExecutionRequest ?? vi.fn(async () => {}),
  }));
  vi.doMock('@common/storage', () => ({
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
  vi.doMock('@logger/AgentLogger', () => ({
    AgentLogger: class {
      static setStreamLogStore(): void {}
    },
  }));
  const { createDesktopAgentExecution } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  return createDesktopAgentExecution({
    postToRenderer: options.postToRenderer ?? vi.fn(),
    showInformationMessage: options.showInformationMessage,
  });
}

function progressMessages(
  messages: unknown[],
  command: string,
): ProgressMessage[] {
  return messages.filter(
    (message): message is ProgressMessage =>
      typeof message === 'object' &&
      message !== null &&
      (message as ProgressMessage).command === command,
  );
}

describe('DesktopProgressBridge', () => {
  afterEach(() => {
    vi.doUnmock('@agent/runtime/AgentRuntimeHost');
    vi.doUnmock('@agent/runtime/RunStorageService');
    vi.doUnmock('@agent/runtime/runExecutionRequest');
    vi.doUnmock('@common/storage');
    vi.doUnmock('@controllers/mainView/MainViewExecutionController');
    vi.doUnmock('@logger/AgentLogger');
    vi.doUnmock('vscode');
    vi.restoreAllMocks();
  });

  it('preserves progress and badge metadata across repeated stream syncs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'parent',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.handleProgressEvent('updateConversationProgress', {
        streamId: 'parent',
        progress: { conversationTurns: 3, toolCallCount: 5 },
      });
      bridge.handleProgressEvent('updateActiveProcesses', {
        parentStreamId: 'parent',
        processes: [{ executionId: 'process-1', agentName: 'bash' }],
      });

      vi.spyOn(Date, 'now').mockReturnValue(2_000);
      bridge.handleProgressEvent('updateActiveSubagents', {
        parentStreamId: 'parent',
        children: [{ executionId: 'agent-1', agentName: 'reviewer' }],
      });

      const streamSync = progressMessages(
        messages,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ).at(-1);
      expect(
        streamSync?.streams?.find((s) => s.name === 'parent'),
      ).toMatchObject({
        creationTimestamp: 1_000,
      });
      expect(streamSync?.streamStates?.parent).toMatchObject({
        conversationProgress: { conversationTurns: 3, toolCallCount: 5 },
        activeSubagents: [{ executionId: 'agent-1', agentName: 'reviewer' }],
        finishedSubagentCount: 0,
        activeProcesses: [{ executionId: 'process-1', agentName: 'bash' }],
        finishedProcessCount: 0,
      });
    } finally {
      bridge.dispose();
    }
  });

  it('accumulates finished child counts without clobbering the other active dimension', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'parent',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.handleProgressEvent('updateActiveProcesses', {
        parentStreamId: 'parent',
        processes: [{ executionId: 'process-1', agentName: 'bash' }],
      });
      bridge.handleProgressEvent('updateActiveSubagents', {
        parentStreamId: 'parent',
        children: [{ executionId: 'agent-1', agentName: 'reviewer' }],
      });
      bridge.handleProgressEvent('updateActiveProcesses', {
        parentStreamId: 'parent',
        processes: [],
      });
      bridge.handleProgressEvent('updateActiveSubagents', {
        parentStreamId: 'parent',
        children: [],
      });

      const badgeUpdate = progressMessages(
        messages,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      ).at(-1);
      expect(badgeUpdate).toMatchObject({
        activeSubagents: [],
        finishedSubagentCount: 1,
        activeProcesses: [],
        finishedProcessCount: 1,
      });
    } finally {
      bridge.dispose();
    }
  });

  it('announces a new stream before sending its first targeted status update', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('updateStreamStatus', {
        streamId: 'new-stream',
        status: STREAM_STATUS.RUNNING,
        previousStatus: STREAM_STATUS.READY,
      });

      expect(
        messages.map((message) => (message as ProgressMessage).command),
      ).toEqual([
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      ]);
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS)[0]
          ?.streamStates?.['new-stream'],
      ).toMatchObject({ status: STREAM_STATUS.RUNNING });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces invalid execution requests through the host notification path', async () => {
    const postToRenderer = vi.fn();
    const showInformationMessage = vi.fn();
    const runValidatedExecutionRequest = vi.fn(async () => {});
    const execution = await createExecution({
      postToRenderer,
      showInformationMessage,
      runValidatedExecutionRequest,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'Select an input file first.',
      })),
    });

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(showInformationMessage).toHaveBeenCalledWith(
        'Select an input file first.',
      );
      expect(postToRenderer).not.toHaveBeenCalled();
      expect(runValidatedExecutionRequest).not.toHaveBeenCalled();
    } finally {
      execution.dispose();
    }
  });

  it('lets runtime execution errors propagate to the IPC error handler', async () => {
    const failure = new Error('execution failed');
    const execution = await createExecution({
      runValidatedExecutionRequest: vi.fn(async () => {
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

    try {
      await expect(
        execution.handleExecute({ command: 'execute' }),
      ).rejects.toThrow(failure);
    } finally {
      execution.dispose();
    }
  });
});
