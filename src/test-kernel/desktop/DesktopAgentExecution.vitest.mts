// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - progress schemas
import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import {
  AGENT_CATEGORY,
  LOG_LEVELS,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import { DESKTOP_SHELL_COMMANDS } from '../../../packages/desktop/src/desktopShellMessages';

type Bridge = {
  openFileCompile(filePath: string): Promise<void>;
  dispose(): void;
};

type TestableBridge = Bridge & {
  handleProgressEvent(event: string, payload: unknown): void;
  setActiveStream(streamId: StreamTabId): void;
  deleteStream(streamId: StreamTabId): Promise<void>;
  deleteAllStreams(): Promise<void>;
  handleAgentProposalAction(message: {
    command: typeof PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION;
    proposalId: string;
    action: 'setup';
  }): Promise<boolean>;
  streamLogs: {
    append(
      streamId: StreamTabId,
      entry: {
        id: string;
        type: string;
        level: string;
        timestamp: number;
        text: string;
      },
    ): unknown;
  };
};

type DesktopExecution = {
  handleExecute(message: unknown): Promise<void>;
  progress: Bridge;
  dispose(): void;
};

type RunExecutionRequest = (
  request: unknown,
  options: {
    openWorkflowOutput(result: {
      outputs: Array<{ absolutePath: string }>;
    }): Promise<void>;
  },
) => Promise<void>;

interface DesktopAgentExecutionModule {
  DesktopProgressBridge: new (
    postToRenderer: (message: unknown) => void,
  ) => Bridge;
  createDesktopAgentExecution(options: {
    postToRenderer(message: unknown): void;
    opener?: {
      openPath(filePath: string): Promise<void>;
      openBuildDisplay?(location: { absolutePath: string }): Promise<void>;
    };
    showErrorMessage?: (message: string) => Promise<void> | void;
  }): DesktopExecution;
}

type ProgressMessage = {
  command?: string;
  activeStream?: string;
  stream?: string;
  streamId?: string;
  entries?: Array<{ text?: string }>;
  streams?: Array<{ name: string; creationTimestamp: number }>;
  streamStates?: Record<string, unknown>;
};

async function createBridge(messages: unknown[]): Promise<TestableBridge> {
  vi.resetModules();
  vi.doMock('@agent/runtime/RunStorageService', () => ({
    setRunStorageService: vi.fn(),
  }));
  vi.doMock('@agent/runtime/runExecutionRequest', () => ({
    runValidatedExecutionRequest: vi.fn(),
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
    prepareMainViewExecutionRequest: vi.fn(),
  }));
  vi.doMock('@logger', () => ({
    createChannelTrace: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    setDefaultStreamLogStore: () => {},
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
  opener?: {
    openPath(filePath: string): Promise<void>;
    openBuildDisplay?(location: { absolutePath: string }): Promise<void>;
  };
  showErrorMessage?: (message: string) => Promise<void> | void;
  prepareMainViewExecutionRequest: (message: unknown) => unknown;
  runValidatedExecutionRequest?: RunExecutionRequest;
}): Promise<DesktopExecution> {
  vi.resetModules();
  vi.doMock('@agent/runtime/RunStorageService', () => ({
    setRunStorageService: vi.fn(),
  }));
  vi.doMock('@agent/runtime/runExecutionRequest', () => ({
    runValidatedExecutionRequest:
      options.runValidatedExecutionRequest ?? vi.fn(async () => {}),
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
  vi.doMock('@logger', () => ({
    createChannelTrace: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    setDefaultStreamLogStore: () => {},
  }));
  const { createDesktopAgentExecution } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  return createDesktopAgentExecution({
    postToRenderer: options.postToRenderer ?? vi.fn(),
    opener: options.opener,
    showErrorMessage: options.showErrorMessage,
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
    vi.doUnmock('@agent/runtime/RunStorageService');
    vi.doUnmock('@agent/runtime/runExecutionRequest');
    vi.doUnmock('@common/storage/KVStore');
    vi.doUnmock('@controllers/mainView/MainViewExecutionController');
    vi.doUnmock('@logger');
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

  it('ignores renderer switches to unknown streams', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.setActiveStream('ghost-stream');

      expect(messages).toEqual([]);
    } finally {
      bridge.dispose();
    }
  });

  it('emits delete-stream cleanup and flushes fallback active stream logs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'first',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.streamLogs.append('first', {
        id: 'first-log',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1_500,
        text: 'first stream log',
      });
      messages.length = 0;

      await bridge.deleteStream('second');

      expect(
        messages.map((message) => (message as ProgressMessage).command),
      ).toEqual([
        PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      ]);
      expect(messages[0]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        stream: 'second',
      });
      expect(messages[1]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        activeStream: 'first',
      });
      expect(messages[2]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        activeStream: 'first',
      });
      expect(messages[3]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId: 'first',
        entries: [expect.objectContaining({ text: 'first stream log' })],
      });
    } finally {
      bridge.dispose();
    }
  });

  it('preserves renderer stream switches that land during active stream deletion', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'first',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'third',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.setActiveStream('second');
      messages.length = 0;

      const deletePromise = bridge.deleteStream('second');
      bridge.setActiveStream('third');
      await deletePromise;

      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
      ).toEqual([
        {
          activeStream: 'third',
          command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        },
      ]);
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
          -1,
        ),
      ).toMatchObject({
        activeStream: 'third',
      });
    } finally {
      bridge.dispose();
    }
  });

  it('falls back if a deleted stream is reactivated during deletion', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'first',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      bridge.setActiveStream('first');
      messages.length = 0;

      const deletePromise = bridge.deleteStream('second');
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      await deletePromise;

      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
      ).toEqual([
        {
          activeStream: 'second',
          command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        },
        {
          activeStream: 'first',
          command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        },
      ]);
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
          -1,
        ),
      ).toMatchObject({
        activeStream: 'first',
      });
    } finally {
      bridge.dispose();
    }
  });

  it('emits delete-all cleanup before syncing an empty stream list', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'active',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
      });
      messages.length = 0;

      await bridge.deleteAllStreams();

      expect(
        messages.map((message) => (message as ProgressMessage).command),
      ).toEqual([
        PROGRESS_VIEW_COMMANDS.DELETE_ALL,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ]);
      expect(messages[1]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        activeStream: '',
        streams: [],
        streamStates: {},
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces invalid execution requests through the host error path', async () => {
    const postToRenderer = vi.fn();
    const showErrorMessage = vi.fn();
    const runValidatedExecutionRequest = vi.fn(async () => {});
    const execution = await createExecution({
      postToRenderer,
      showErrorMessage,
      runValidatedExecutionRequest,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'Select an input file first.',
      })),
    });

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(showErrorMessage).toHaveBeenCalledWith(
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

  it('passes remote agent launches to the shared runtime unchanged', async () => {
    const request = {
      agentName: 'remote:remoteWriter',
      filePath: 'main.tex',
      prompt: 'draft',
    };
    const runValidatedExecutionRequest = vi.fn(async () => {});
    const execution = await createExecution({
      runValidatedExecutionRequest,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request,
      })),
    });

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(runValidatedExecutionRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          openWorkflowOutput: expect.any(Function),
        }),
      );
    } finally {
      execution.dispose();
    }
  });

  it('opens workflow outputs through the desktop preview host', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const runValidatedExecutionRequest = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outputs: [{ absolutePath: '/tmp/result.pdf' }],
      });
    });
    const execution = await createExecution({
      opener,
      runValidatedExecutionRequest,
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
      await execution.handleExecute({ command: 'execute' });
      expect(opener.openPath).toHaveBeenCalledWith('/tmp/result.pdf');
    } finally {
      execution.dispose();
    }
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

    try {
      await execution.progress.openFileCompile('/tmp/output.tex');
      expect(opener.openBuildDisplay).toHaveBeenCalledWith(
        expect.objectContaining({ absolutePath: '/tmp/output.tex' }),
      );
      expect(opener.openPath).not.toHaveBeenCalled();
    } finally {
      execution.dispose();
    }
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

    try {
      await execution.progress.openFileCompile('/tmp/output.tex');
      expect(opener.openPath).not.toHaveBeenCalled();
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Desktop LaTeX preview is unavailable. Cannot compile and open this file.',
      );
    } finally {
      execution.dispose();
    }
  });

  it('restores agent proposal setup into the desktop launcher', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('showAgentProposal', {
        proposalId: 'proposal-1',
        streamId: 'stream-1',
        agentCategory: AGENT_CATEGORY.WORKFLOW,
        agent: 'proofreader',
        model: 'gemini31p',
        instruction: 'Check this draft.',
        inputFiles: ['main.tex', 'appendix.tex'],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: ['main.review.tex'],
        useMultipleOutputs: false,
        toolConfig: DEFAULT_TOOL_CONFIG,
      });
      messages.length = 0;

      await expect(
        bridge.handleAgentProposalAction({
          command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
          proposalId: 'proposal-1',
          action: 'setup',
        }),
      ).resolves.toBe(true);

      expect(messages).toEqual([
        { command: DESKTOP_SHELL_COMMANDS.SET_ROUTE, route: 'main' },
        expect.objectContaining({
          command: COMMON_COMMANDS.STATE_RESTORE,
          state: expect.objectContaining({
            sessionType: 'workflow',
            model: 'gemini31p',
            instruction: 'Check this draft.',
            inputFiles: ['main.tex', 'appendix.tex'],
            outputFiles: ['main.review.tex'],
          }),
        }),
      ]);
    } finally {
      bridge.dispose();
    }
  });
});
