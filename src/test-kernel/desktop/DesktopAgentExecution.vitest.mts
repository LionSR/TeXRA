// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent state
import { TaskStateSchema } from '@agent/core/state/TaskState';

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
import { DIAGNOSTICS_ADD_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import type { StreamSnapshotStore as ProgressSnapshotStore } from '@transcript';

type Bridge = {
  openFileCompile(filePath: string): Promise<void>;
  flush(): Promise<void>;
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
    releaseEntries(streamId: StreamTabId): void;
    load(): Promise<void>;
    ensureLoaded(streamId: StreamTabId): Promise<void>;
    get(streamId: StreamTabId):
      | {
          getRange(fromSeq: number): Array<{ text?: string }>;
        }
      | undefined;
  };
};

type BridgeWithSession = TestableBridge & {
  session: {
    hostChannel?: {
      emit(event: string, payload: unknown): void;
    };
    coordinators: {
      cleanupAllRequests(): void;
    };
  };
};

type DesktopExecution = {
  handleExecute(message: unknown): Promise<void>;
  progress: Bridge;
  flush(): Promise<void>;
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
    runtimeUnavailableTools?: readonly string[];
  },
) => Promise<void>;

interface DesktopAgentExecutionModule {
  DesktopProgressBridge: new (
    postToRenderer: (message: unknown) => void,
    options?: {
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
  kvStoreBacking?: Map<string, unknown>;
  kvRead?: (key: string) => Promise<unknown> | unknown;
  retrieveSessionResumeData?: ReturnType<typeof vi.fn>;
  resumeToolUseFromSnapshot?: ReturnType<typeof vi.fn>;
  runAgent?: RunExecutionRequest;
  streamSnapshotStore?: TestDesktopStreamSnapshotStore;
  configureProgressSnapshotStore?: (store: ProgressSnapshotStore) => void;
  detectWaitingStreams?: ReturnType<typeof vi.fn>;
  activeExecutionIds?: readonly string[] | (() => readonly string[]);
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

function mockLoggerModule(): void {
  vi.doMock('@logger', () => ({
    createChannelTrace: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    setDefaultStreamLogStore: () => {},
  }));
}

async function createBridge(
  messages: unknown[],
  options: CreateBridgeOptions = {},
): Promise<TestableBridge> {
  vi.resetModules();
  vi.doMock('@agent/runtime/ProgressViewBridge', () => ({
    setProgressViewBridge: vi.fn(),
  }));
  vi.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData:
      options.retrieveSessionResumeData ?? vi.fn(async () => null),
  }));
  vi.doMock('@agent/runtime/executeAgent', () => ({
    resumeToolUseFromSnapshot:
      options.resumeToolUseFromSnapshot ?? vi.fn(async () => {}),
  }));
  vi.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(),
  }));
  vi.doMock('@agent/runtime/SessionHandle', async () => {
    const actual = await vi.importActual<
      typeof import('@agent/runtime/SessionHandle')
    >('@agent/runtime/SessionHandle');
    return {
      ...actual,
      getAllActiveExecutionIds: vi.fn(() =>
        typeof options.activeExecutionIds === 'function'
          ? options.activeExecutionIds()
          : (options.activeExecutionIds ?? []),
      ),
    };
  });
  vi.doMock('@agent/storage/detectWaitingStreams', () => ({
    detectWaitingStreams:
      options.detectWaitingStreams ?? vi.fn(async () => new Set()),
  }));
  vi.doMock('@common/storage/KVStore', () => ({
    KVStore: class {
      constructor(private readonly dir: string) {}

      async read(key: string): Promise<unknown> {
        return (
          options.kvRead?.(key) ?? options.kvStoreBacking?.get(this.key(key))
        );
      }

      async write(key: string, value: unknown): Promise<void> {
        options.kvStoreBacking?.set(this.key(key), value);
      }

      async delete(key: string): Promise<void> {
        options.kvStoreBacking?.delete(this.key(key));
      }

      async deleteDir(): Promise<void> {
        if (!options.kvStoreBacking) return;
        for (const key of options.kvStoreBacking.keys()) {
          if (key.startsWith(`${this.dir}/`))
            options.kvStoreBacking.delete(key);
        }
      }

      async exists(): Promise<boolean> {
        return false;
      }

      async listKeys(): Promise<string[]> {
        if (!options.kvStoreBacking) return [];
        const prefix = `${this.dir}/`;
        return [...options.kvStoreBacking.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length));
      }

      private key(key: string): string {
        return `${this.dir}/${key}`;
      }
    },
  }));
  vi.doMock('@controllers/mainView/MainViewExecutionController', () => ({
    prepareMainViewExecutionRequest: vi.fn(),
  }));
  mockLoggerModule();
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

function restoredSnapshot(
  overrides: Partial<RestoredStreamSnapshot> &
    Pick<RestoredStreamSnapshot, 'streamId'>,
): RestoredStreamSnapshot {
  return {
    label: overrides.streamId,
    agentCategory: AgentCategory.Workflow,
    lastKnownStatus: STREAM_STATUS.STOPPED,
    creationTimestamp: 1_000,
    persistedAt: 2_000,
    ...overrides,
  };
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
    vi.doUnmock('@agent/runtime/ProgressViewBridge');
    vi.doUnmock('@agent/runtime/SessionResumeRetrieval');
    vi.doUnmock('@agent/runtime/executeAgent');
    vi.doUnmock('@agent/runtime/runAgent');
    vi.doUnmock('@agent/storage/detectWaitingStreams');
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
  });

  it('routes host-path runtime events through the desktop session host channel', async () => {
    const messages: unknown[] = [];
    const streamSnapshotStore = createStreamSnapshotStore([]);
    const bridge = (await createBridge(messages, {
      streamSnapshotStore,
    })) as BridgeWithSession;
    const { emitRuntimeEvent } =
      await import('@agent/runtime/emitRuntimeEvent');
    const session = bridge.session as unknown as Parameters<
      typeof emitRuntimeEvent
    >[2];

    try {
      emitRuntimeEvent(
        'setTaskState',
        {
          streamId: 'desktop-host-stream',
          executionId: 'desktop-host-exec',
          taskState: TaskStateSchema.parse(workflowTaskState()),
        },
        session,
      );

      await vi.waitFor(() => {
        expect(streamSnapshotStore.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            streamId: 'desktop-host-stream',
            executionId: 'desktop-host-exec',
          }),
        );
      });
    } finally {
      bridge.dispose();
    }
  });

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

  it('repairs restored running streams after desktop startup', async () => {
    const messages: unknown[] = [];
    const detectWaitingStreams = vi.fn(
      async (executionIds: ReadonlyMap<StreamTabId, string>) => {
        expect([...executionIds.entries()].toSorted()).toEqual([
          ['dead-stream', 'def456'],
          ['waiting-stream', 'abc123'],
        ]);
        return new Set<StreamTabId>(['waiting-stream']);
      },
    );
    const bridge = await createBridge(messages, {
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'waiting-stream',
          executionId: 'abc123',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
        restoredSnapshot({
          streamId: 'dead-stream',
          executionId: 'def456',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => {
        expect(detectWaitingStreams).toHaveBeenCalledOnce();
        expect(StreamStatusService.get('waiting-stream')).toBe(
          STREAM_STATUS.WAITING,
        );
        expect(StreamStatusService.get('dead-stream')).toBe(
          STREAM_STATUS.ERROR,
        );
      });

      const streamSync = progressMessages(
        messages,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ).at(-1);
      expect(streamSync?.streamStates?.['waiting-stream']).toMatchObject({
        status: STREAM_STATUS.WAITING,
      });
      expect(streamSync?.streamStates?.['dead-stream']).toMatchObject({
        status: STREAM_STATUS.ERROR,
      });
    } finally {
      StreamStatusService.clear('waiting-stream', { emit: false });
      StreamStatusService.clear('dead-stream', { emit: false });
      bridge.dispose();
    }
  });

  it('waits for desktop startup repair before starting a run', async () => {
    let finishRepair!: (value: Set<StreamTabId>) => void;
    const repairGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishRepair = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => repairGate);
    const runAgent = vi.fn(async () => {});
    const bridge = await createBridge([], {
      detectWaitingStreams,
      runAgent,
    });
    const taskState = workflowTaskState();

    try {
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-new',
        executionId: 'abc123',
        taskState,
      });

      const runNew =
        bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW];
      expect(runNew).toBeTypeOf('function');
      const runPromise = runNew?.({
        command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
        stream: 'stream-new',
      });

      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      await settleProgressEvents();
      expect(runAgent).not.toHaveBeenCalled();

      finishRepair(new Set());
      await runPromise;

      expect(runAgent).toHaveBeenCalledOnce();
    } finally {
      finishRepair(new Set());
      bridge.dispose();
    }
  });

  it('marks restored running streams as errored when startup repair fails', async () => {
    const detectWaitingStreams = vi.fn(async () => {
      throw new Error('flow store unavailable');
    });
    const bridge = await createBridge([], {
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'broken-stream',
          executionId: 'abc123',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => {
        expect(detectWaitingStreams).toHaveBeenCalledOnce();
        expect(StreamStatusService.get('broken-stream')).toBe(
          STREAM_STATUS.ERROR,
        );
      });
    } finally {
      StreamStatusService.clear('broken-stream', { emit: false });
      bridge.dispose();
    }
  });

  it('does not repair restored streams whose execution is active', async () => {
    const detectWaitingStreams = vi.fn(
      async (executionIds: ReadonlyMap<StreamTabId, string>) => {
        expect([...executionIds.entries()]).toEqual([
          ['dead-stream', 'def456'],
        ]);
        return new Set<StreamTabId>();
      },
    );
    const bridge = await createBridge([], {
      activeExecutionIds: ['abc123'],
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'active-stream',
          executionId: 'abc123',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
        restoredSnapshot({
          streamId: 'dead-stream',
          executionId: 'def456',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => {
        expect(detectWaitingStreams).toHaveBeenCalledOnce();
        expect(StreamStatusService.get('active-stream')).toBe(
          STREAM_STATUS.RUNNING,
        );
        expect(StreamStatusService.get('dead-stream')).toBe(
          STREAM_STATUS.ERROR,
        );
      });
    } finally {
      StreamStatusService.clear('active-stream', { emit: false });
      StreamStatusService.clear('dead-stream', { emit: false });
      bridge.dispose();
    }
  });

  it('uses durable execution ids to keep active restored streams out of repair', async () => {
    const detectWaitingStreams = vi.fn(
      async (executionIds: ReadonlyMap<StreamTabId, string>) => {
        expect([...executionIds.entries()]).toEqual([
          ['dead-stream', 'def456'],
        ]);
        return new Set<StreamTabId>();
      },
    );
    const bridge = await createBridge([], {
      activeExecutionIds: ['abc123'],
      configureProgressSnapshotStore: (store) => {
        store.setTaskState(
          'active-stream',
          TaskStateSchema.parse(workflowTaskState()),
          'abc123',
        );
      },
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'active-stream',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
        restoredSnapshot({
          streamId: 'dead-stream',
          executionId: 'def456',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => {
        expect(detectWaitingStreams).toHaveBeenCalledOnce();
        expect(StreamStatusService.get('active-stream')).toBe(
          STREAM_STATUS.RUNNING,
        );
        expect(StreamStatusService.get('dead-stream')).toBe(
          STREAM_STATUS.ERROR,
        );
      });
    } finally {
      StreamStatusService.clear('active-stream', { emit: false });
      StreamStatusService.clear('dead-stream', { emit: false });
      bridge.dispose();
    }
  });

  it('rechecks active executions after waiting detection before resetting streams', async () => {
    let activeExecutionIds: readonly string[] = [];
    let finishDetection!: (value: Set<StreamTabId>) => void;
    const detectionGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => detectionGate);
    const bridge = await createBridge([], {
      activeExecutionIds: () => activeExecutionIds,
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'race-stream',
          executionId: 'abc123',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      activeExecutionIds = ['abc123'];
      finishDetection(new Set<StreamTabId>(['race-stream']));

      await vi.waitFor(() => {
        expect(StreamStatusService.get('race-stream')).toBe(
          STREAM_STATUS.RUNNING,
        );
      });
    } finally {
      finishDetection(new Set());
      StreamStatusService.clear('race-stream', { emit: false });
      bridge.dispose();
    }
  });

  it('closes running transcript groups for streams repaired to waiting', async () => {
    let finishDetection!: (value: Set<StreamTabId>) => void;
    const detectionGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => detectionGate);
    const bridge = await createBridge([], {
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'waiting-stream',
          executionId: 'abc123',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const streamLogs = bridge.streamLogs as typeof bridge.streamLogs & {
      endRunningGroupsForStreams: (
        streamIds: readonly StreamTabId[],
        now?: number,
      ) => Promise<StreamTabId[]>;
    };
    const closeSpy = vi.spyOn(streamLogs, 'endRunningGroupsForStreams');

    try {
      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      finishDetection(new Set<StreamTabId>(['waiting-stream']));

      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalledWith(
          ['waiting-stream'],
          expect.any(Number),
        );
      });
    } finally {
      finishDetection(new Set());
      bridge.dispose();
    }
  });

  it('keeps waiting repairs waiting when a later repair step fails', async () => {
    let finishDetection!: (value: Set<StreamTabId>) => void;
    const detectionGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => detectionGate);
    const bridge = await createBridge([], {
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'waiting-stream',
          executionId: 'abc123',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const streamLogs = bridge.streamLogs as typeof bridge.streamLogs & {
      endRunningGroupsForStreams: (
        streamIds: readonly StreamTabId[],
        now?: number,
      ) => Promise<StreamTabId[]>;
    };
    const closeSpy = vi
      .spyOn(streamLogs, 'endRunningGroupsForStreams')
      .mockRejectedValueOnce(new Error('group close failed'))
      .mockResolvedValueOnce(['waiting-stream']);
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      finishDetection(new Set<StreamTabId>(['waiting-stream']));

      await vi.waitFor(() => {
        expect(StreamStatusService.get('waiting-stream')).toBe(
          STREAM_STATUS.WAITING,
        );
        expect(closeSpy).toHaveBeenCalledTimes(2);
        expect(closeSpy).toHaveBeenLastCalledWith(
          ['waiting-stream'],
          expect.any(Number),
        );
      });
    } finally {
      finishDetection(new Set());
      StreamStatusService.clear('waiting-stream', { emit: false });
      bridge.dispose();
    }
  });

  it('marks restored running streams without execution ids as errored', async () => {
    const detectWaitingStreams = vi.fn(async () => new Set<StreamTabId>());
    const bridge = await createBridge([], {
      detectWaitingStreams,
      streamSnapshotStore: createStreamSnapshotStore([
        restoredSnapshot({
          streamId: 'no-execution-stream',
          lastKnownStatus: STREAM_STATUS.RUNNING,
        }),
      ]),
    });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      await vi.waitFor(() => {
        expect(detectWaitingStreams).toHaveBeenCalledWith(new Map());
        expect(StreamStatusService.get('no-execution-stream')).toBe(
          STREAM_STATUS.ERROR,
        );
      });
    } finally {
      StreamStatusService.clear('no-execution-stream', { emit: false });
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
        restoredSnapshot({ streamId: 'ghost-stream' }),
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
    const kvRead = vi.fn(async (key: string) => {
      if (key === 'meta') return undefined;
      throw new Error('unexpected sidecar disk read');
    });
    const detectWaitingStreams = vi.fn(async () => new Set<StreamTabId>());
    const bridge = await createBridge(messages, {
      kvRead,
      detectWaitingStreams,
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
        restoredSnapshot({ streamId: 'ghost-stream' }),
      ]),
    });

    try {
      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      bridge.setActiveStream('ghost-stream');
      await settleProgressEvents();

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
        restoredSnapshot({ streamId: 'ghost-stream' }),
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
        restoredSnapshot({ streamId: 'ghost-stream' }),
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
        restoredSnapshot({ streamId: 'ghost-one' }),
        restoredSnapshot({
          streamId: 'ghost-two',
          creationTimestamp: 1_100,
          persistedAt: 2_100,
        }),
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
          runtimeUnavailableTools: [
            'list_api_keys',
            'inline_comment',
            DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
          ],
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
          activeFiles: expect.objectContaining({
            input: false,
            context: false,
            media: false,
            output: false,
          }),
          agentConfig: expect.objectContaining(taskState.agentConfig),
        }),
      );
      expectWorkflowResume(runAgent, taskState, executionId);
    } finally {
      StreamStatusService.clear('stream-1', { emit: false });
      bridge.dispose();
    }
  });

  it('runs a fresh stream through the shared workflow-actions controller', async () => {
    const taskState = workflowTaskState();
    const runAgent = vi.fn(async () => {});
    const bridge = await createBridge([], { runAgent });

    try {
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-new',
        executionId: 'exec-new',
        taskState,
      });

      const runNew =
        bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW];
      expect(runNew).toBeTypeOf('function');
      await runNew?.({
        command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
        stream: 'stream-new',
      });

      // Fresh run: the existing execution id is dropped (no resume reuse).
      expect(runAgent).toHaveBeenCalledWith(
        { config: expect.objectContaining(taskState.agentConfig) },
        expect.objectContaining({
          runtimeHost: expect.objectContaining({ emit: expect.any(Function) }),
        }),
      );
    } finally {
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
        restoredSnapshot({
          streamId: 'stream-1',
          label: 'proofreader',
          agent: 'proofreader',
          executionId,
        }),
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
          activeFiles: expect.objectContaining({
            input: false,
            context: false,
            media: false,
            output: false,
          }),
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
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: 'exec-1',
        streamId: 'stream-1',
        agentConfig: {
          agent: 'search',
          model: 'deepseekproT',
          agentCategory: AgentCategory.ToolUse,
        },
      },
    }));
    const resumeToolUseFromSnapshot = vi.fn(async () => {});
    const messages: unknown[] = [];
    const bridge = await createBridge(messages, {
      retrieveSessionResumeData,
      resumeToolUseFromSnapshot,
    });
    const { ToolUseFollowUpQueue } =
      await import('@agent/followUp/ToolUseFollowUpQueueManager');
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');
    const taskState = {
      agentConfig: {
        agent: 'search',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
      },
    };

    try {
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-1',
        executionId: 'exec-1',
        taskState,
      });
      ToolUseFollowUpQueue.enqueue(
        'stream-1',
        { text: 'queued follow-up' },
        { force: true },
      );

      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        'exec-1',
        taskState,
      );
      expect(resumeToolUseFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'exec-1',
          streamId: 'stream-1',
        }),
        expect.objectContaining({ emit: expect.any(Function) }),
        expect.objectContaining({ setupSession: expect.any(Function) }),
      );
      const [, , resumeOptions] = resumeToolUseFromSnapshot.mock
        .calls[0] as unknown as [
        unknown,
        unknown,
        {
          setupSession(session: {
            appendFollowUp(followUp: {
              text: string;
              mediaFiles?: readonly string[];
              displayText?: string;
              origin?: 'user' | 'subagent_result';
            }): void;
          }): void;
        },
      ];
      const appendFollowUp = vi.fn();
      resumeOptions.setupSession({ appendFollowUp });
      expect(appendFollowUp).toHaveBeenCalledWith({
        text: 'queued follow-up',
        origin: 'user',
      });
    } finally {
      ToolUseFollowUpQueue.release('stream-1');
      StreamStatusService.clear('stream-1', { emit: false });
      bridge.dispose();
    }
  });

  it('keeps queued follow-ups when tool-use resume fails', async () => {
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'toolUse',
      snapshot: {
        executionId: 'exec-1',
        streamId: 'stream-1',
        agentConfig: {
          agent: 'search',
          model: 'deepseekproT',
          agentCategory: AgentCategory.ToolUse,
        },
      },
    }));
    const resumeToolUseFromSnapshot = vi.fn(async () => {
      throw new Error('resume failed');
    });
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      resumeToolUseFromSnapshot,
    });
    const { ToolUseFollowUpQueue } =
      await import('@agent/followUp/ToolUseFollowUpQueueManager');
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-1',
        executionId: 'exec-1',
        taskState: {
          agentConfig: {
            agent: 'search',
            model: 'deepseekproT',
            agentCategory: AgentCategory.ToolUse,
          },
        },
      });
      ToolUseFollowUpQueue.enqueue(
        'stream-1',
        { text: 'queued follow-up' },
        { force: true },
      );

      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      expect(ToolUseFollowUpQueue.getAll('stream-1')).toEqual([
        'queued follow-up',
      ]);
      expect(StreamStatusService.get('stream-1')).toBe(STREAM_STATUS.WAITING);
    } finally {
      ToolUseFollowUpQueue.release('stream-1');
      StreamStatusService.clear('stream-1', { emit: false });
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
          executionId: 'exec-1',
          streamId: 'stream-1',
          agentConfig: {
            agent: 'search',
            model: 'deepseekproT',
            agentCategory: AgentCategory.ToolUse,
          },
        },
      };
    });
    const bridge = await createBridge([], { retrieveSessionResumeData });
    const { StreamStatusService } =
      await import('@agent/runtime/StreamStatusService');

    try {
      bridge.handleProgressEvent('setTaskState', {
        streamId: 'stream-1',
        executionId: 'exec-1',
        taskState: {
          agentConfig: {
            agent: 'search',
            model: 'deepseekproT',
            agentCategory: AgentCategory.ToolUse,
          },
        },
      });

      const firstResume = bridge.tryResumeStream('stream-1');
      await retrieveStartedPromise;
      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      allowRetrieve();
      await expect(firstResume).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledTimes(1);
    } finally {
      StreamStatusService.clear('stream-1', { emit: false });
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

  it('flushes debounced stream logs before shutdown can drop them', async () => {
    const streamId = 'shutdown-flush' as StreamTabId;
    const kvStoreBacking = new Map<string, unknown>();
    const bridge = await createBridge([], { kvStoreBacking });

    try {
      bridge.streamLogs.append(streamId, {
        id: 'shutdown-log',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1_000,
        text: 'persist me before quit',
      });

      await bridge.flush();
      bridge.streamLogs.releaseEntries(streamId);
      await bridge.streamLogs.load();
      await bridge.streamLogs.ensureLoaded(streamId);

      expect(
        bridge.streamLogs
          .get(streamId)
          ?.getRange(0)
          .map((entry) => entry.text),
      ).toEqual(['persist me before quit']);
    } finally {
      bridge.dispose();
    }
  });
});
