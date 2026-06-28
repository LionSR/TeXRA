// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - progress schemas
import { DESKTOP_SHELL_COMMANDS } from '@desktop/desktopShellMessages';
import {
  AgentCategory,
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_STATUS,
  type RestoredStreamSnapshot,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { COMMON_COMMANDS } from '@shared/ipc/commonCommands';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

// Local imports - desktop test paths
import {
  desktopSourcePath,
  moduleFileUrl,
  repoPath,
} from './desktopTestPaths.mjs';
import type { StreamSnapshotStore as ProgressSnapshotStore } from '@transcript';

type Bridge = {
  openFileCompile(filePath: string): Promise<void>;
  dispose(): void;
};

type TestableBridge = Bridge & {
  handleProgressEvent(event: string, payload: unknown): void;
  syncFullView(): void;
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
  setActiveStream(streamId: StreamTabId): void;
  deleteStream(streamId: StreamTabId): Promise<void>;
  deleteAllStreams(): Promise<void>;
  progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;
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

type BridgeWithSession = TestableBridge & {
  session: unknown & {
    coordinators: {
      cleanupAllRequests(): void;
    };
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
      outcome: RunOutcome;
      outputs: Array<{ absolutePath: string }>;
    }): Promise<void>;
    // This window's SessionHandle. The onboarding run-completion test drives a
    // terminal `result` event through it via `attachRunTrace`.
    session: {
      attachRunTrace(trace: {
        subscribe(fn: (event: unknown) => void): unknown;
      }): () => void;
    };
  },
) => Promise<void>;

interface DesktopAgentExecutionModule {
  DesktopProgressBridge: new (
    postToRenderer: (message: unknown) => void,
    options?: {
      showErrorMessage?: (message: string) => Promise<void> | void;
      streamSnapshotStore?: TestDesktopStreamSnapshotStore;
      progressSnapshotStore?: ProgressSnapshotStore;
    },
  ) => Bridge;
  createDesktopAgentExecution(options: {
    postToRenderer(message: unknown): void;
    opener?: {
      openPath(filePath: string): Promise<void>;
      openBuildDisplay?(location: { absolutePath: string }): Promise<void>;
    };
    showErrorMessage?: (message: string) => Promise<void> | void;
    onRunCompleted?: () => void;
  }): DesktopExecution;
}

type CreateBridgeOptions = {
  kvRead?: (key: string) => Promise<unknown> | unknown;
  retrieveSessionResumeData?: ReturnType<typeof vi.fn>;
  resumeToolUseFromSnapshot?: ReturnType<typeof vi.fn>;
  runAgent?: RunExecutionRequest;
  requestRuntimeStreamStop?: ReturnType<typeof vi.fn>;
  requestRuntimeFollowUp?: ReturnType<typeof vi.fn>;
  showErrorMessage?: (message: string) => Promise<void> | void;
  streamSnapshotStore?: TestDesktopStreamSnapshotStore;
  configureProgressSnapshotStore?: (store: ProgressSnapshotStore) => void;
};

type TestDesktopStreamSnapshotStore = {
  readonly hydrated: readonly RestoredStreamSnapshot[];
  upsert(snapshot: RestoredStreamSnapshot): Promise<void>;
  remove(streamId: StreamTabId): Promise<void>;
  replaceAll(snapshots: RestoredStreamSnapshot[]): Promise<void>;
  getAll(): RestoredStreamSnapshot[];
};

type ProgressMessage = {
  command?: string;
  activeStream?: string;
  stream?: string;
  streamId?: string;
  todos?: unknown[];
  plan?: unknown;
  runId?: string;
  usage?: unknown;
  entries?: Array<{ text?: string }>;
  rounds?: Record<string, unknown>;
  reset?: boolean;
  streams?: Array<{ name: string; creationTimestamp: number }>;
  streamStates?: Record<string, unknown>;
};

async function createBridge(
  messages: unknown[],
  options: CreateBridgeOptions = {},
): Promise<TestableBridge> {
  vi.resetModules();
  const retrieveSessionResumeData =
    options.retrieveSessionResumeData ?? vi.fn(async () => null);
  vi.doMock('@agent/runtime/progressViewCommands', () => ({
    registerRuntimeProgressViewVisibilityProvider: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    isRuntimeProgressViewVisible: vi.fn(() => true),
  }));
  if (options.requestRuntimeStreamStop) {
    vi.doMock('@agent/runtime/streamControl', async () => ({
      ...((await vi.importActual('@agent/runtime/streamControl')) as object),
      requestRuntimeStreamStop: options.requestRuntimeStreamStop,
    }));
  }
  if (options.requestRuntimeFollowUp) {
    vi.doMock('@agent/runtime/followUpCommands', async () => ({
      ...((await vi.importActual('@agent/runtime/followUpCommands')) as object),
      requestRuntimeFollowUp: options.requestRuntimeFollowUp,
    }));
  }
  vi.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData,
  }));
  const resumeToolUseFromSnapshot =
    options.resumeToolUseFromSnapshot ?? vi.fn(async () => {});
  const executeAgentMock = () => ({ resumeToolUseFromSnapshot });
  vi.doMock('@agent/runtime/executeAgent', executeAgentMock);
  vi.doMock(
    repoPath('src', 'agent', 'runtime', 'executeAgent'),
    executeAgentMock,
  );
  vi.doMock(
    repoPath('src', 'agent', 'runtime', 'executeAgent.ts'),
    executeAgentMock,
  );
  vi.doMock(
    moduleFileUrl(repoPath('src', 'agent', 'runtime', 'executeAgent.ts')),
    executeAgentMock,
  );
  vi.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(),
  }));
  vi.doMock('@common/storage/KVStore', () => ({
    KVStore: class {
      async read(key: string): Promise<unknown> {
        return options.kvRead?.(key);
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
  let progressSnapshotStore: ProgressSnapshotStore | undefined;
  if (options.configureProgressSnapshotStore) {
    const { StreamSnapshotStore } = await import('@transcript');
    progressSnapshotStore = new StreamSnapshotStore();
    await progressSnapshotStore.load([]);
    options.configureProgressSnapshotStore(progressSnapshotStore);
    await progressSnapshotStore.flush();
  }
  const { DesktopProgressBridge } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  return new DesktopProgressBridge((message) => messages.push(message), {
    showErrorMessage: options.showErrorMessage,
    streamSnapshotStore: options.streamSnapshotStore,
    progressSnapshotStore,
  }) as TestableBridge;
}

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
  vi.doMock('@agent/runtime/progressViewCommands', () => ({
    registerRuntimeProgressViewVisibilityProvider: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    isRuntimeProgressViewVisible: vi.fn(() => true),
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
    onRunCompleted: options.onRunCompleted,
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

function createStreamSnapshotStore(
  hydrated: readonly RestoredStreamSnapshot[],
): TestDesktopStreamSnapshotStore {
  const live = new Map(
    hydrated.map((snapshot) => [snapshot.streamId, snapshot]),
  );
  return {
    hydrated,
    upsert: vi.fn(async (snapshot: RestoredStreamSnapshot) => {
      live.set(snapshot.streamId, snapshot);
    }),
    remove: vi.fn(async (streamId: StreamTabId) => {
      live.delete(streamId);
    }),
    replaceAll: vi.fn(async (snapshots: RestoredStreamSnapshot[]) => {
      live.clear();
      for (const snapshot of snapshots) live.set(snapshot.streamId, snapshot);
    }),
    getAll: () => [...live.values()],
  };
}

function workflowTaskState(): {
  agentConfig: {
    agent: string;
    model: string;
    agentCategory: typeof AgentCategory.Workflow;
    toolConfig: typeof DEFAULT_TOOL_CONFIG;
  };
  activeFiles: Record<string, boolean>;
} {
  return {
    agentConfig: {
      agent: 'proofreader',
      model: 'deepseekproT',
      agentCategory: AgentCategory.Workflow,
      toolConfig: DEFAULT_TOOL_CONFIG,
    },
    activeFiles: {},
  };
}

function toolUseTaskState(): {
  agentConfig: {
    agent: string;
    model: string;
    agentCategory: typeof AgentCategory.ToolUse;
    toolConfig: typeof DEFAULT_TOOL_CONFIG;
  };
  toolSessionState: Record<string, never>;
} {
  return {
    agentConfig: {
      agent: 'search',
      model: 'deepseekproT',
      agentCategory: AgentCategory.ToolUse,
      toolConfig: DEFAULT_TOOL_CONFIG,
    },
    toolSessionState: {},
  };
}

function expectWorkflowResume(
  runAgent: ReturnType<typeof vi.fn>,
  taskState: ReturnType<typeof workflowTaskState>,
  executionId: string,
): void {
  expect(runAgent).toHaveBeenCalledWith(
    {
      config: expect.objectContaining(taskState.agentConfig),
      executionId,
    },
    expect.objectContaining({
      runtimeHost: expect.objectContaining({ emit: expect.any(Function) }),
      openWorkflowOutput: expect.any(Function),
    }),
  );
}

async function settleProgressEvents(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('DesktopProgressBridge', () => {
  afterEach(() => {
    vi.doUnmock('@agent/runtime/progressViewCommands');
    vi.doUnmock('@agent/runtime/SessionResumeRetrieval');
    vi.doUnmock('@agent/runtime/resumeCommands');
    vi.doUnmock('@agent/runtime/executeAgent');
    vi.doUnmock(repoPath('src', 'agent', 'runtime', 'executeAgent'));
    vi.doUnmock(repoPath('src', 'agent', 'runtime', 'executeAgent.ts'));
    vi.doUnmock(
      moduleFileUrl(repoPath('src', 'agent', 'runtime', 'executeAgent.ts')),
    );
    vi.doUnmock('@agent/runtime/runAgent');
    vi.doUnmock('@common/storage/KVStore');
    vi.doUnmock('@controllers/mainView/MainViewExecutionController');
    vi.doUnmock('@logger');
    vi.doUnmock('vscode');
    vi.restoreAllMocks();
  });

  it('mirrors runtime events to the shared progress bus', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);
    const { bus } = await import('@eventBus/ProgressEventBus');
    const seen: unknown[] = [];
    const off = bus.on('updateTodos', (payload) => {
      seen.push(payload);
    });

    try {
      bridge.handleProgressEvent('updateTodos', {
        streamId: 'parent',
        todos: [],
      });
      expect(seen).toEqual([{ streamId: 'parent', todos: [] }]);
    } finally {
      off();
      bridge.dispose();
    }
  }, 30_000);

  it('preserves progress and badge metadata across repeated stream syncs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'parent',
        agentCategory: AgentCategory.Workflow,
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
      await settleProgressEvents();
      messages.length = 0;
      bridge.syncFullView();

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
        agentCategory: AgentCategory.Workflow,
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
      ).toEqual([PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]);
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

  it('restores a ghost stream display from shared streamData sidecars', async () => {
    const messages: unknown[] = [];
    const plan = {
      objective: [
        'Restore the prior display state.',
        '',
        'Load all durable progress-view sidecar fields.',
      ].join('\n'),
    };
    const outputLocation = {
      kind: 'workspace',
      absolutePath: '/workspace/out/paper.pdf',
      relativePath: 'out/paper.pdf',
    };
    const logLocation = {
      kind: 'workspace',
      absolutePath: '/workspace/out/paper.log',
      relativePath: 'out/paper.log',
    };
    const sidecars: Record<string, unknown> = {
      workPlan: {
        todos: [
          {
            content: 'Persisted todo',
            status: 'pending',
            activeForm: 'Restoring persisted todo',
          },
        ],
        plan,
        planSummary: 'Restore the prior display state.',
      },
      usageStats: {
        'run-1': {
          inputTokens: 42,
          outputTokens: 7,
          cost: 0.12,
        },
      },
      outputFiles: {
        '1': [
          {
            source: 'paper.tex',
            location: outputLocation,
            round: 1,
            lineage: null,
            diff: null,
          },
        ],
      },
      missingOutputs: { '1': ['out/missing.pdf'] },
      compileFailures: {
        '1': [
          {
            round: 1,
            displayName: 'paper.tex',
            output: outputLocation,
            log: logLocation,
            logRelativePath: 'out/paper.log',
          },
        ],
      },
    };
    const bridge = await createBridge(messages, {
      kvRead: (key) => sidecars[key],
      streamSnapshotStore: createStreamSnapshotStore([
        {
          streamId: 'ghost-stream',
          label: 'ghost-stream',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          creationTimestamp: 1_000,
          persistedAt: 2_000,
        },
      ]),
    });

    try {
      bridge.setActiveStream('ghost-stream');
      await settleProgressEvents();
      const last = (command: string) =>
        progressMessages(messages, command).at(-1);

      expect(last(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS)).toMatchObject({
        stream: 'ghost-stream',
        todos: [expect.objectContaining({ content: 'Persisted todo' })],
      });
      expect(last(PROGRESS_VIEW_COMMANDS.UPDATE_PLAN)).toMatchObject({
        stream: 'ghost-stream',
        plan,
      });
      expect(last(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE)).toMatchObject({
        stream: 'ghost-stream',
        runId: 'run-1',
        usage: { inputTokens: 42, outputTokens: 7, cost: 0.12 },
      });
      expect(last(PROGRESS_VIEW_COMMANDS.UPDATE_FILES)).toMatchObject({
        stream: 'ghost-stream',
        rounds: {
          '1': [expect.objectContaining({ source: 'paper.tex', round: 1 })],
        },
      });
      expect(last(PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS)).toMatchObject(
        {
          stream: 'ghost-stream',
          rounds: { '1': ['out/missing.pdf'] },
        },
      );
      expect(
        last(PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES),
      ).toMatchObject({
        stream: 'ghost-stream',
        rounds: {
          '1': [expect.objectContaining({ logRelativePath: 'out/paper.log' })],
        },
        reset: true,
      });
    } finally {
      bridge.dispose();
    }
  });

  it('restores ghost display from the backend snapshot store', async () => {
    const messages: unknown[] = [];
    const kvRead = vi.fn(async () => {
      throw new Error('unexpected sidecar disk read');
    });
    const bridge = await createBridge(messages, {
      kvRead,
      configureProgressSnapshotStore: (store) => {
        store.setTodos('ghost-stream', [
          {
            content: 'Preloaded backend todo',
            status: 'pending',
            activeForm: 'Restoring from backend store',
          },
        ]);
      },
      streamSnapshotStore: createStreamSnapshotStore([
        {
          streamId: 'ghost-stream',
          label: 'ghost-stream',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          creationTimestamp: 1_000,
          persistedAt: 2_000,
        },
      ]),
    });

    try {
      bridge.setActiveStream('ghost-stream');
      await settleProgressEvents();

      expect(kvRead).not.toHaveBeenCalled();
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_TODOS).at(-1),
      ).toMatchObject({
        stream: 'ghost-stream',
        todos: [
          expect.objectContaining({
            content: 'Preloaded backend todo',
          }),
        ],
      });
    } finally {
      bridge.dispose();
    }
  });

  it('retries ghost display restore after a durable read failure', async () => {
    const messages: unknown[] = [];
    let failed = false;
    const kvRead = vi.fn(async (key: string) => {
      if (!failed) {
        failed = true;
        throw new Error('temporary read failure');
      }
      if (key === 'workPlan') {
        return {
          todos: [
            {
              content: 'Persisted todo',
              status: 'pending',
              activeForm: 'Restoring persisted todo',
            },
          ],
          plan: null,
          planSummary: null,
        };
      }
      return undefined;
    });
    const bridge = await createBridge(messages, {
      kvRead,
      streamSnapshotStore: createStreamSnapshotStore([
        {
          streamId: 'ghost-stream',
          label: 'ghost-stream',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          creationTimestamp: 1_000,
          persistedAt: 2_000,
        },
      ]),
    });

    try {
      bridge.setActiveStream('ghost-stream');
      await settleProgressEvents();
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
      ).toHaveLength(0);

      messages.length = 0;
      bridge.setActiveStream('ghost-stream');
      await settleProgressEvents();

      expect(kvRead).toHaveBeenCalledWith('workPlan');
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_TODOS).at(-1),
      ).toMatchObject({
        stream: 'ghost-stream',
        todos: [
          expect.objectContaining({
            content: 'Persisted todo',
          }),
        ],
      });
    } finally {
      bridge.dispose();
    }
  });

  it('deduplicates overlapping ghost display restores', async () => {
    const messages: unknown[] = [];
    let releaseRead: () => void = () => undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let shouldDelayFirstWorkPlanRead = true;
    const kvRead = vi.fn(async (key: string) => {
      if (key === 'workPlan' && shouldDelayFirstWorkPlanRead) {
        shouldDelayFirstWorkPlanRead = false;
        await firstRead;
      }
      if (key === 'workPlan') {
        return {
          todos: [
            {
              content: 'Single restored todo',
              status: 'pending',
              activeForm: 'Restoring once',
            },
          ],
          plan: null,
          planSummary: null,
        };
      }
      return undefined;
    });
    const bridge = await createBridge(messages, {
      kvRead,
      streamSnapshotStore: createStreamSnapshotStore([
        {
          streamId: 'ghost-stream',
          label: 'ghost-stream',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          creationTimestamp: 1_000,
          persistedAt: 2_000,
        },
      ]),
    });

    try {
      bridge.setActiveStream('ghost-stream');
      bridge.setActiveStream('ghost-stream');
      await settleProgressEvents();
      releaseRead();
      await settleProgressEvents();

      const todoUpdates = progressMessages(
        messages,
        PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
      ).filter((message) => message.stream === 'ghost-stream');
      expect(todoUpdates).toHaveLength(1);
      expect(todoUpdates[0]).toMatchObject({
        todos: [
          expect.objectContaining({
            content: 'Single restored todo',
          }),
        ],
      });
      expect(
        kvRead.mock.calls.filter(([key]) => key === 'workPlan'),
      ).toHaveLength(1);
    } finally {
      bridge.dispose();
    }
  });

  it('retries ghost display restore after a stale async read', async () => {
    const messages: unknown[] = [];
    let releaseRead: () => void = () => undefined;
    let markReadStarted: () => void = () => undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const firstReadStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let shouldDelayFirstWorkPlanRead = true;
    const kvRead = vi.fn(async (key: string) => {
      if (key === 'workPlan' && shouldDelayFirstWorkPlanRead) {
        shouldDelayFirstWorkPlanRead = false;
        markReadStarted();
        await firstRead;
      }
      if (key === 'workPlan') {
        return {
          todos: [
            {
              content: 'Delayed todo',
              status: 'pending',
              activeForm: 'Restoring delayed todo',
            },
          ],
          plan: null,
          planSummary: null,
        };
      }
      return undefined;
    });
    const bridge = await createBridge(messages, {
      kvRead,
      streamSnapshotStore: createStreamSnapshotStore([
        {
          streamId: 'ghost-one',
          label: 'ghost-one',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          creationTimestamp: 1_000,
          persistedAt: 2_000,
        },
        {
          streamId: 'ghost-two',
          label: 'ghost-two',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          creationTimestamp: 1_100,
          persistedAt: 2_100,
        },
      ]),
    });

    try {
      bridge.setActiveStream('ghost-one');
      await firstReadStarted;
      bridge.setActiveStream('ghost-two');
      releaseRead();
      await settleProgressEvents();
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_TODOS).filter(
          (message) => message.stream === 'ghost-one',
        ),
      ).toHaveLength(0);

      messages.length = 0;
      bridge.setActiveStream('ghost-one');
      await settleProgressEvents();

      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_TODOS).at(-1),
      ).toMatchObject({
        stream: 'ghost-one',
        todos: [
          expect.objectContaining({
            content: 'Delayed todo',
          }),
        ],
      });
    } finally {
      bridge.dispose();
    }
  });

  it('does not route to progress for suppressed background stream switches', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'child-stream',
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
      });
      await settleProgressEvents();

      expect(
        messages.some(
          (message) =>
            (message as ProgressMessage).command ===
              DESKTOP_SHELL_COMMANDS.SET_ROUTE &&
            (message as { route?: string }).route === 'progress',
        ),
      ).toBe(false);
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
        agentCategory: AgentCategory.Workflow,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AgentCategory.Workflow,
      });
      bridge.streamLogs.append('first', {
        id: 'first-log',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1_500,
        text: 'first stream log',
      });
      await settleProgressEvents();
      messages.length = 0;

      await bridge.deleteStream('second');
      await settleProgressEvents();

      await vi.waitFor(() =>
        expect(
          messages.map((message) => (message as ProgressMessage).command),
        ).toEqual([
          PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
          PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
          PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
          PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        ]),
      );
      expect(messages[0]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        stream: 'second',
      });
      expect(messages[1]).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
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

  it('routes stop and follow-up through each desktop window session', async () => {
    const stopA = vi.fn((request) => ({
      streamId: request.streamId,
      status: 'not_found',
      clearedRetryRequest: request.clearRetryRequest === true,
    }));
    const stopB = vi.fn((request) => ({
      streamId: request.streamId,
      status: 'not_found',
      clearedRetryRequest: request.clearRetryRequest === true,
    }));
    const followUpA = vi.fn(async () => ({
      outcome: 'sent',
      accepted: true,
    }));
    const followUpB = vi.fn(async () => ({
      outcome: 'sent',
      accepted: true,
    }));
    const bridgeA = await createBridge([], {
      requestRuntimeStreamStop: stopA,
      requestRuntimeFollowUp: followUpA,
    });
    const bridgeB = await createBridge([], {
      requestRuntimeStreamStop: stopB,
      requestRuntimeFollowUp: followUpB,
    });
    const taskState = toolUseTaskState();
    const sessionA = (bridgeA as BridgeWithSession).session;
    const sessionB = (bridgeB as BridgeWithSession).session;

    try {
      expect(sessionA).not.toBe(sessionB);
      const stopHandlerA =
        bridgeA.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.STOP_STREAM
        ]!;
      const stopHandlerB =
        bridgeB.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.STOP_STREAM
        ]!;
      const followUpHandlerA =
        bridgeA.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP
        ]!;
      const followUpHandlerB =
        bridgeB.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP
        ]!;

      await stopHandlerA({
        command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
        stream: 'stream-a',
      } as never);
      await stopHandlerB({
        command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
        stream: 'stream-b',
      } as never);
      bridgeA.handleProgressEvent('setTaskState', {
        streamId: 'stream-a',
        executionId: 'abc123',
        taskState,
      });
      bridgeB.handleProgressEvent('setTaskState', {
        streamId: 'stream-b',
        executionId: 'def456',
        taskState,
      });
      await followUpHandlerA({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'stream-a',
        text: 'continue A',
      } as never);
      await followUpHandlerB({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: 'stream-b',
        text: 'continue B',
      } as never);

      expect(stopA).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-a',
          clearRetryRequest: true,
          session: sessionA,
        }),
      );
      expect(stopB).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-b',
          clearRetryRequest: true,
          session: sessionB,
        }),
      );
      expect(followUpA).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-a',
          text: 'continue A',
          session: sessionA,
          persistedWaitingExecutionId: 'abc123',
          wakeQueuedStream: true,
        }),
      );
      expect(followUpB).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-b',
          text: 'continue B',
          session: sessionB,
          persistedWaitingExecutionId: 'def456',
          wakeQueuedStream: true,
        }),
      );
    } finally {
      bridgeA.dispose();
      bridgeB.dispose();
    }
  });

  it('does not resume a stream deleted in this desktop session', async () => {
    const taskState = {
      agentConfig: {
        agent: 'search',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
      },
    };
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: 'exec-1',
        streamId: 'stream-1',
        agentConfig: taskState.agentConfig,
      },
    }));
    const bridge = await createBridge([], {
      kvRead: vi.fn(async () => ({
        executionId: 'exec-1',
        taskState,
      })),
      retrieveSessionResumeData,
    });

    try {
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-1',
        executionId: 'exec-1',
        taskState,
      });

      await bridge.deleteStream('stream-1');
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-1',
        executionId: 'exec-1',
        taskState,
      });
      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      expect(retrieveSessionResumeData).not.toHaveBeenCalled();
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
        agentCategory: AgentCategory.Workflow,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AgentCategory.Workflow,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'third',
        agentCategory: AgentCategory.Workflow,
      });
      await settleProgressEvents();
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
        agentCategory: AgentCategory.Workflow,
      });
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AgentCategory.Workflow,
      });
      await settleProgressEvents();
      bridge.setActiveStream('first');
      messages.length = 0;

      const deletePromise = bridge.deleteStream('second');
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'second',
        agentCategory: AgentCategory.Workflow,
      });
      await deletePromise;

      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
      ).toEqual([
        {
          activeStream: 'second',
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
    const cleanupAllRequests = vi.spyOn(
      (bridge as BridgeWithSession).session.coordinators,
      'cleanupAllRequests',
    );

    try {
      bridge.handleProgressEvent('setActiveStream', {
        streamId: 'active',
        agentCategory: AgentCategory.Workflow,
      });
      await settleProgressEvents();
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
      expect(cleanupAllRequests).toHaveBeenCalledOnce();
    } finally {
      bridge.dispose();
    }
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

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Select an input file first.',
      );
      expect(postToRenderer).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
    } finally {
      execution.dispose();
    }
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
    const runAgent = vi.fn(async () => {});
    const execution = await createExecution({
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request,
      })),
    });

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(runAgent).toHaveBeenCalledWith(
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
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [{ absolutePath: '/tmp/result.pdf' }],
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

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(opener.openPath).toHaveBeenCalledWith('/tmp/result.pdf');
    } finally {
      execution.dispose();
    }
  });

  // Minimal AgentTrace stand-in: the desktop bridge bridges a run's trace into
  // the window session's onResult channel via `session.attachRunTrace`, which
  // only needs `subscribe`. `emit` fans an event out to subscribers, matching
  // how the real lifecycle publishes the terminal `result` event.
  function makeFakeTrace(): {
    subscribe(fn: (event: unknown) => void): () => void;
    emit(event: unknown): void;
  } {
    const subscribers = new Set<(event: unknown) => void>();
    return {
      subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      emit(event) {
        for (const fn of subscribers) fn(event);
      },
    };
  }

  it('fires onRunCompleted when a run reaches a completed terminal result', async () => {
    const onRunCompleted = vi.fn();
    // The mock run bridges a trace into the window session's onResult channel
    // (mirroring AgentLaunchContext.attachRunTrace) and emits a completed
    // result — exactly what the lifecycle does after persisting firstRunDone.
    const runAgent = vi.fn(async (_request, options) => {
      const trace = makeFakeTrace();
      options.session.attachRunTrace(trace);
      trace.emit({
        type: 'result',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId: 'exec-1',
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

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(onRunCompleted).toHaveBeenCalledOnce();
    } finally {
      execution.dispose();
    }
  });

  it('does not fire onRunCompleted on a failed terminal result', async () => {
    const onRunCompleted = vi.fn();
    const runAgent = vi.fn(async (_request, options) => {
      const trace = makeFakeTrace();
      options.session.attachRunTrace(trace);
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

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(onRunCompleted).not.toHaveBeenCalled();
    } finally {
      execution.dispose();
    }
  });

  it('does not auto-open outputs of a non-completed workflow', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.CANCELLED,
        outputs: [{ absolutePath: '/tmp/result.pdf' }],
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

    try {
      await execution.handleExecute({ command: 'execute' });
      expect(opener.openPath).not.toHaveBeenCalled();
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

  it('resumes workflow streams from persisted meta', async () => {
    const executionId = 'abc123';
    const taskState = workflowTaskState();
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'workflow',
      agentConfig: taskState.agentConfig,
      executionId,
    }));
    const runAgent = vi.fn(async () => {});
    const kvRead = vi.fn(async (key: string) =>
      key === 'meta'
        ? {
            executionId,
            taskState,
            description: 'Persisted workflow',
          }
        : undefined,
    );
    const bridge = await createBridge([], {
      kvRead,
      retrieveSessionResumeData,
      runAgent,
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(true);
      expect(kvRead).toHaveBeenCalledWith('meta');
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        executionId,
        expect.objectContaining({
          activeFiles: {},
          agentConfig: expect.objectContaining(taskState.agentConfig),
        }),
      );
      expectWorkflowResume(runAgent, taskState, executionId);
    } finally {
      StreamStatusService.clear('stream-1', { emit: false });
      bridge.dispose();
    }
  });

  it('resumes hydrated ghost streams using hinted execution ids', async () => {
    const executionId = 'abc123';
    const taskState = workflowTaskState();
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'workflow',
      agentConfig: taskState.agentConfig,
      executionId,
    }));
    const runAgent = vi.fn(async () => {});
    const kvRead = vi.fn(async (key: string) =>
      key === 'meta'
        ? {
            taskState,
            description: 'Persisted workflow',
          }
        : undefined,
    );
    const bridge = await createBridge([], {
      kvRead,
      retrieveSessionResumeData,
      runAgent,
      streamSnapshotStore: createStreamSnapshotStore([
        {
          streamId: 'stream-1',
          label: 'proofreader',
          agent: 'proofreader',
          agentCategory: AgentCategory.Workflow,
          lastKnownStatus: STREAM_STATUS.STOPPED,
          executionId,
          creationTimestamp: 1_000,
          persistedAt: 2_000,
        },
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        executionId,
        expect.objectContaining({
          activeFiles: {},
          agentConfig: expect.objectContaining(taskState.agentConfig),
        }),
      );
      expectWorkflowResume(runAgent, taskState, executionId);
    } finally {
      StreamStatusService.clear('stream-1', { emit: false });
      bridge.dispose();
    }
  });

  it('resumes tool-use streams through the shared snapshot path', async () => {
    const streamId = 'tool-use-resume-shared-path' as StreamTabId;
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: 'abc123',
        streamId,
        agentConfig: {
          agent: 'search',
          model: 'deepseekproT',
          agentCategory: AgentCategory.ToolUse,
          toolConfig: DEFAULT_TOOL_CONFIG,
        },
      },
    }));
    const resumeToolUseFromSnapshot = vi.fn(async () => {});
    const messages: unknown[] = [];
    const taskState = toolUseTaskState();
    const kvRead = vi.fn(async (key: string) =>
      key === 'meta'
        ? {
            executionId: 'abc123',
            taskState,
          }
        : undefined,
    );
    const bridge = await createBridge(messages, {
      kvRead,
      retrieveSessionResumeData,
      resumeToolUseFromSnapshot,
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      const session = (bridge as BridgeWithSession).session;
      StreamStatusService.clear(streamId, { emit: false });

      await expect(bridge.tryResumeStream(streamId)).resolves.toBe(true);
      expect(kvRead).toHaveBeenCalledWith('meta');
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        streamId,
        'abc123',
        expect.objectContaining({
          agentConfig: expect.objectContaining(taskState.agentConfig),
          toolSessionState: {},
        }),
      );
      expect(resumeToolUseFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'abc123',
          streamId,
        }),
        expect.objectContaining({
          emit: expect.any(Function),
        }),
        expect.objectContaining({
          session,
        }),
      );
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
      bridge.dispose();
    }
  });

  it('routes tool-use resume through each desktop window session', async () => {
    const streamIdA = 'tool-use-resume-window-a' as StreamTabId;
    const streamIdB = 'tool-use-resume-window-b' as StreamTabId;
    const executionIdA = 'abc123';
    const executionIdB = 'def456';
    const taskState = toolUseTaskState();
    const resumeA = vi.fn(async () => {});
    const resumeB = vi.fn(async () => {});
    const retrieveA = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: executionIdA,
        streamId: streamIdA,
        agentConfig: taskState.agentConfig,
      },
    }));
    const retrieveB = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: executionIdB,
        streamId: streamIdB,
        agentConfig: taskState.agentConfig,
      },
    }));
    const bridgeA = await createBridge([], {
      kvRead: vi.fn(async (key: string) =>
        key === 'meta'
          ? {
              executionId: executionIdA,
              taskState,
            }
          : undefined,
      ),
      retrieveSessionResumeData: retrieveA,
      resumeToolUseFromSnapshot: resumeA,
    });
    const bridgeB = await createBridge([], {
      kvRead: vi.fn(async (key: string) =>
        key === 'meta'
          ? {
              executionId: executionIdB,
              taskState,
            }
          : undefined,
      ),
      retrieveSessionResumeData: retrieveB,
      resumeToolUseFromSnapshot: resumeB,
    });
    const sessionA = (bridgeA as BridgeWithSession).session;
    const sessionB = (bridgeB as BridgeWithSession).session;

    try {
      expect(sessionA).not.toBe(sessionB);

      await expect(bridgeA.tryResumeStream(streamIdA)).resolves.toBe(true);
      await expect(bridgeB.tryResumeStream(streamIdB)).resolves.toBe(true);

      expect(retrieveA).toHaveBeenCalledWith(
        streamIdA,
        executionIdA,
        expect.objectContaining({
          agentConfig: expect.objectContaining(taskState.agentConfig),
        }),
      );
      expect(retrieveB).toHaveBeenCalledWith(
        streamIdB,
        executionIdB,
        expect.objectContaining({
          agentConfig: expect.objectContaining(taskState.agentConfig),
        }),
      );
      expect(resumeA).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: executionIdA,
          streamId: streamIdA,
        }),
        expect.objectContaining({
          emit: expect.any(Function),
        }),
        expect.objectContaining({
          session: sessionA,
        }),
      );
      expect(resumeB).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: executionIdB,
          streamId: streamIdB,
        }),
        expect.objectContaining({
          emit: expect.any(Function),
        }),
        expect.objectContaining({
          session: sessionB,
        }),
      );
    } finally {
      bridgeA.dispose();
      bridgeB.dispose();
    }
  });

  it('reports failures from the shared tool-use snapshot resume path', async () => {
    const streamId = 'tool-use-resume-failure-path' as StreamTabId;
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: 'abc123',
        streamId,
        agentConfig: {
          agent: 'search',
          model: 'deepseekproT',
          agentCategory: AgentCategory.ToolUse,
          toolConfig: DEFAULT_TOOL_CONFIG,
        },
      },
    }));
    const resumeToolUseFromSnapshot = vi.fn(async () => {
      throw new Error('resume failed');
    });
    const showErrorMessage = vi.fn();
    const taskState = toolUseTaskState();
    const kvRead = vi.fn(async (key: string) =>
      key === 'meta'
        ? {
            executionId: 'abc123',
            taskState,
          }
        : undefined,
    );
    const bridge = await createBridge([], {
      kvRead,
      retrieveSessionResumeData,
      resumeToolUseFromSnapshot,
      showErrorMessage,
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      const session = (bridge as BridgeWithSession).session;
      StreamStatusService.clear(streamId, { emit: false });

      await expect(bridge.tryResumeStream(streamId)).resolves.toBe(false);
      expect(kvRead).toHaveBeenCalledWith('meta');
      expect(resumeToolUseFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'abc123',
          streamId,
        }),
        expect.objectContaining({
          emit: expect.any(Function),
        }),
        expect.objectContaining({
          session,
        }),
      );
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Resume failed: resume failed',
      );
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
      bridge.dispose();
    }
  });

  it('does not launch a duplicate resume for active streams', async () => {
    const retrieveSessionResumeData = vi.fn(async () => null);
    const bridge = await createBridge([], { retrieveSessionResumeData });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      StreamStatusService.set('stream-1', STREAM_STATUS.RUNNING, {
        emit: false,
      });

      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      expect(retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      StreamStatusService.clear('stream-1', { emit: false });
      bridge.dispose();
    }
  });

  it('does not launch duplicate concurrent resume attempts', async () => {
    const streamId = 'tool-use-resume-concurrent-path' as StreamTabId;
    let allowRetrieve: () => void = () => undefined;
    const retrieveGate = new Promise<void>((resolve) => {
      allowRetrieve = resolve;
    });
    let retrieveStarted: () => void = () => undefined;
    const retrieveStartedPromise = new Promise<void>((resolve) => {
      retrieveStarted = resolve;
    });
    const retrieveSessionResumeData = vi.fn(async () => {
      retrieveStarted();
      await retrieveGate;
      return {
        type: 'toolUse',
        snapshot: {
          executionId: 'abc123',
          streamId,
          agentConfig: {
            agent: 'search',
            model: 'deepseekproT',
            agentCategory: AgentCategory.ToolUse,
            toolConfig: DEFAULT_TOOL_CONFIG,
          },
        },
      };
    });
    const taskState = toolUseTaskState();
    const kvRead = vi.fn(async (key: string) =>
      key === 'meta'
        ? {
            executionId: 'abc123',
            taskState,
          }
        : undefined,
    );
    const bridge = await createBridge([], {
      kvRead,
      retrieveSessionResumeData,
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      StreamStatusService.clear(streamId, { emit: false });
      const firstResume = bridge.tryResumeStream(streamId);
      await retrieveStartedPromise;
      await expect(bridge.tryResumeStream(streamId)).resolves.toBe(false);
      allowRetrieve();
      await expect(firstResume).resolves.toBe(true);
      expect(kvRead).toHaveBeenCalledWith('meta');
      expect(retrieveSessionResumeData).toHaveBeenCalledTimes(1);
    } finally {
      StreamStatusService.clear(streamId, { emit: false });
      bridge.dispose();
    }
  });

  it('restores agent proposal setup into the desktop launcher', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    try {
      bridge.handleProgressEvent('showAgentProposal', {
        proposalId: 'proposal-1',
        streamId: 'stream-1',
        agentCategory: AgentCategory.Workflow,
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

      const handleProposal =
        bridge.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION
        ];
      expect(handleProposal).toBeTypeOf('function');
      await handleProposal?.({
        command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
        proposalId: 'proposal-1',
        action: 'setup',
      });

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
