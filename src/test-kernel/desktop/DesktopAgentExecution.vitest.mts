// Node imports
import { access } from 'node:fs/promises';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace, type AgentEvent, type AgentTrace } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent, SessionFact } from '@agent/runtime/SessionEventHub';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { PlanApprovalResult } from '@agent/runtime/HostInteractions';
import {
  TaskStateSchema,
  type WorkflowTaskState,
} from '@agent/core/state/TaskState';
import {
  AgentConfigSchema,
  WorkflowAgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { DESKTOP_SHELL_COMMANDS } from '@desktop/desktopShellMessages';
import type { AgentResumePort } from '@platform/interfaces';
import {
  AgentCategory,
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type OutputFileInfo,
  type StorageKey,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { assertSupported } from '@shared/utils/dispatcher';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { seedStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import {
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
} from '@tools/approval';
import {
  STREAM_LOGS_DIR,
  type StreamLogStore,
  type StreamSnapshotStore as ProgressSnapshotStore,
} from '@transcript';

// Local file imports
import {
  createStubDesktopAgentExecutionHost,
  disposeAfterTest,
  makeFakeTrace,
  type DesktopAgentExecutionModule,
  type RunExecutionRequest,
} from './desktopAgentExecutionTestHarness.mjs';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type Bridge = {
  openFileCompile(filePath: string): Promise<void>;
  dispose(): void;
};

type TestableBridge = Bridge & {
  fileActions: {
    host: { startExecution(request: unknown): void };
  };
  hostInteractions: {
    submitPlanDecision(
      requestId: string,
      decision: PlanApprovalResult,
    ): boolean;
  };
  waitUntilReady(): Promise<void>;
  runtimeHost: {
    emit(event: string, payload: unknown): void;
  };
  handleInteractionEvent(event: string, payload: unknown): void;
  syncFullView(): void;
  completeWebviewReady(): Promise<void>;
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
  setActiveStream(streamId: StreamTabId): void;
  revealStream(streamId: StreamTabId): Promise<void>;
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
    reload(): Promise<void>;
    ensureLoaded(streamId: StreamTabId): Promise<void>;
    getUnfinishedStreamIds(): StreamTabId[];
    get(streamId: StreamTabId):
      | {
          getRange(fromSeq: number): Array<{
            type?: string;
            text?: string;
            data?: unknown;
          }>;
        }
      | undefined;
  };
};

type BridgeWithSession = TestableBridge & {
  session: {
    executions: SessionHandle['executions'];
    interactions: {
      cancel(selector?: { cause?: string }): void;
      requestPlanApproval?: (request: {
        approvalId: string;
        streamId: StreamTabId;
        plan: { objective: string };
        goalEnabled: boolean;
      }) => Promise<unknown>;
      requestAgentProposal?: (request: unknown) => Promise<unknown>;
      requestRetry?: (request: {
        streamId: StreamTabId;
        operation: string;
      }) => Promise<unknown>;
      requestBashApproval?: (request: {
        command: string;
        streamId?: StreamTabId;
      }) => Promise<unknown>;
      requestToolEditApproval?: (request: {
        path: string;
        originalContent: string;
        proposedContent: string;
        sourceTool: string;
        streamId?: StreamTabId;
      }) => Promise<unknown>;
    };
    status: StreamStatusMachine;
    events: SessionHandle['events'];
    followUps: {
      enqueue(
        streamId: StreamTabId,
        followUp: { text: string },
        options?: { force?: boolean },
      ): boolean;
      getAll(streamId: StreamTabId): string[];
      release(streamId: StreamTabId): void;
    };
  };
};

function bridgeInteractions(
  bridge: TestableBridge,
): BridgeWithSession['session']['interactions'] {
  return (bridge as BridgeWithSession).session.interactions;
}

function bridgeStatus(
  bridge: TestableBridge,
): BridgeWithSession['session']['status'] {
  return (bridge as BridgeWithSession).session.status;
}

function bridgeFollowUps(
  bridge: TestableBridge,
): BridgeWithSession['session']['followUps'] {
  return (bridge as BridgeWithSession).session.followUps;
}

type CreateBridgeOptions = {
  kvStoreBacking?: Map<string, unknown>;
  kvRead?: (key: string) => Promise<unknown> | unknown;
  /** Forces persistent transcript opening to reject. */
  transcriptOpenError?: Error;
  /** Delays persistent transcript opening until this promise resolves. */
  transcriptOpenGate?: Promise<void>;
  retrieveSessionResumeData?: ReturnType<typeof vi.fn>;
  resumeToolUseFromResumeData?: ReturnType<typeof vi.fn>;
  runAgent?: RunExecutionRequest;
  canonicalStreamIds?: readonly StreamTabId[];
  configureTranscripts?: (store: StreamLogStore) => Promise<void> | void;
  configureProgressSnapshotStore?: (
    store: ProgressSnapshotStore,
  ) => Promise<void> | void;
  configureSession?: (session: SessionHandle) => Promise<void> | void;
  deferReady?: boolean;
  detectWaitingStreams?: ReturnType<typeof vi.fn>;
  repairRestartedStreams?: ReturnType<typeof vi.fn>;
  wakeQueuedFollowUpStream?: ReturnType<typeof vi.fn>;
  showErrorMessage?: (message: string) => Promise<void> | void;
  openPath?: (filePath: string, line?: number) => Promise<void>;
  observeRendererMessage?: (message: unknown) => void;
  /** Captures `this.logger.error(...)` calls made by the bridge under test. */
  loggerErrorSpy?: ReturnType<typeof vi.fn<AgentTrace['error']>>;
};

type ProgressMessage = {
  command?: string;
  action?: string;
  kind?: string;
  activeStream?: string;
  agentFilter?: string;
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
  streamState?: unknown;
  runUsage?: Record<string, unknown>;
  outputs?: {
    files: Record<string, unknown>;
    missing: Record<string, unknown>;
    compileFailures: Record<string, unknown>;
  };
  activeState?: unknown;
  permission?: { data?: { approvalId?: string } };
};

/** Shared fixture for the tool-use "search" agentConfig used across several
 * resume tests below. */
const SEARCH_TOOL_USE_AGENT_CONFIG = AgentConfigSchema.parse({
  agent: 'search',
  model: 'deepseekproT',
  agentCategory: AgentCategory.ToolUse,
});

/**
 * Registers the desktop module mocks once and imports the bridge module.
 * `createBridge` builds one window on top of this; the multi-window isolation
 * tests load the module once and construct several `DesktopProgressBridge`
 * windows from the same module registry — matching how the desktop main
 * process hosts multiple BrowserWindows over one set of process globals.
 */
async function loadBridgeModule(options: CreateBridgeOptions = {}): Promise<{
  bridgeModule: DesktopAgentExecutionModule;
  openTranscripts(): Promise<StreamLogStore>;
  createSession(transcripts: StreamLogStore): SessionHandle;
  createProgressSnapshotStore(): ProgressSnapshotStore;
  processResumeOwner: import('@desktop/main/desktopAgentResume').DesktopProcessResumeOwner;
  progressSnapshotStore: ProgressSnapshotStore;
}> {
  vi.resetModules();
  const kvStoreBacking = options.kvStoreBacking ?? new Map<string, unknown>();
  let resumeDelegate: AgentResumePort = {
    tryResumeStream: async () => false,
    isResumeInFlight: () => false,
  };
  const agentResume: AgentResumePort = {
    tryResumeStream: (streamId) => resumeDelegate.tryResumeStream(streamId),
    isResumeInFlight: (streamId) =>
      resumeDelegate.isResumeInFlight?.(streamId) ?? false,
  };
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform({}, { agentResume }));
  vi.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData:
      options.retrieveSessionResumeData ?? vi.fn(async () => null),
  }));
  vi.doMock('@agent/runtime/executeAgent', () => ({
    resumeToolUseFromResumeData:
      options.resumeToolUseFromResumeData ?? vi.fn(async () => {}),
  }));
  vi.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(),
  }));
  vi.doMock('@agent/followUp/ToolUseFollowUp', async () => {
    const actual = await vi.importActual<
      typeof import('@agent/followUp/ToolUseFollowUp')
    >('@agent/followUp/ToolUseFollowUp');
    return options.wakeQueuedFollowUpStream
      ? {
          ...actual,
          wakeQueuedFollowUpStream: options.wakeQueuedFollowUpStream,
        }
      : actual;
  });
  vi.doMock('@agent/storage/detectWaitingStreams', () => ({
    detectWaitingStreams:
      options.detectWaitingStreams ?? vi.fn(async () => new Set()),
  }));
  vi.doMock('@controllers/progressView/backend/restartRepair', async () => {
    const actual = await vi.importActual<
      typeof import('@controllers/progressView/backend/restartRepair')
    >('@controllers/progressView/backend/restartRepair');
    return options.repairRestartedStreams
      ? {
          ...actual,
          repairRestartedStreams: options.repairRestartedStreams,
        }
      : actual;
  });
  vi.doMock('@common/storage/KVStore', () => ({
    KVStore: class {
      constructor(private readonly dir: string) {}

      async read(key: string): Promise<unknown> {
        return options.kvRead?.(key) ?? kvStoreBacking.get(this.key(key));
      }

      async write(key: string, value: unknown): Promise<void> {
        kvStoreBacking.set(this.key(key), value);
      }

      async delete(key: string): Promise<void> {
        kvStoreBacking.delete(this.key(key));
      }

      async deleteDir(): Promise<void> {
        for (const key of kvStoreBacking.keys()) {
          if (key.startsWith(`${this.dir}/`)) kvStoreBacking.delete(key);
        }
      }

      async exists(): Promise<boolean> {
        return false;
      }

      async modifiedAt(): Promise<number | undefined> {
        return 1;
      }

      async listKeys(): Promise<string[]> {
        if (options.transcriptOpenError && this.dir === STREAM_LOGS_DIR) {
          throw options.transcriptOpenError;
        }
        if (options.transcriptOpenGate && this.dir === STREAM_LOGS_DIR) {
          await options.transcriptOpenGate;
        }
        const prefix = `${this.dir}/`;
        return [...kvStoreBacking.keys()]
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
  const { StreamLogStore, StreamSnapshotStore } = await import('@transcript');
  const createProgressSnapshotStore = (): ProgressSnapshotStore =>
    new StreamSnapshotStore();
  const progressSnapshotStore = createProgressSnapshotStore();
  const bridgeModule = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  const { DesktopProcessResumeOwner } =
    await import('@desktop/main/desktopAgentResume');
  const processResumeOwner = new DesktopProcessResumeOwner();
  resumeDelegate = processResumeOwner;
  const { initializeDefaultSession, SessionHandle } =
    await import('@agent/runtime/SessionHandle');
  initializeDefaultSession({
    transcripts: StreamLogStore.ephemeral('desktop module test default'),
  });
  return {
    bridgeModule,
    createSession: (transcripts) => new SessionHandle({ transcripts }),
    createProgressSnapshotStore,
    openTranscripts: () => StreamLogStore.open(),
    processResumeOwner,
    progressSnapshotStore,
  };
}

async function createBridge(
  messages: unknown[],
  options: CreateBridgeOptions = {},
): Promise<TestableBridge> {
  const {
    bridgeModule,
    createSession,
    openTranscripts,
    processResumeOwner,
    progressSnapshotStore,
  } = await loadBridgeModule(options);
  const transcripts = await openTranscripts();
  for (const streamId of options.canonicalStreamIds ?? []) {
    transcripts.ensureStream(streamId);
  }
  await options.configureTranscripts?.(transcripts);
  await transcripts.flush();
  await progressSnapshotStore.load(transcripts.keys());
  if (options.configureProgressSnapshotStore) {
    await options.configureProgressSnapshotStore(progressSnapshotStore);
    await progressSnapshotStore.flush();
  }
  const session = createSession(transcripts);
  const { SessionStores } =
    await import('@controllers/progressView/backend/state/SessionStores');
  const { releaseStreamResources } = await import('@tools/approval');
  const { GoalStore: bridgeGoalStore } = await import('@tools/goal');
  const sessionStores = new SessionStores({
    streamLogs: transcripts,
    snapshots: progressSnapshotStore,
    goalEntries: {
      forget: (stream) => bridgeGoalStore.forget(stream, session),
      forgetMany: (streams) => bridgeGoalStore.forgetMany(streams, session),
    },
    onCanonicalStreamDeleted: (stream) => {
      session.status.clearStream(stream);
      releaseStreamResources(stream, session);
    },
  });
  const disposeResumeHandler = processResumeOwner.attach({
    session,
    snapshots: progressSnapshotStore,
  });
  const detachSnapshotEvents = progressSnapshotStore.attachSessionEvents(
    session.events,
  );
  await options.configureSession?.(session);
  const bridge = new bridgeModule.DesktopProgressBridge(
    (message) => {
      options.observeRendererMessage?.(message);
      messages.push(message);
    },
    {
      session,
      sessionStores,
      logger: options.loggerErrorSpy
        ? { ...noopTrace, error: options.loggerErrorSpy }
        : undefined,
      progressSnapshotStore,
      host: createStubDesktopAgentExecutionHost({
        ...(options.showErrorMessage
          ? { showErrorMessage: options.showErrorMessage }
          : {}),
        ...(options.openPath ? { openPath: options.openPath } : {}),
      }),
    },
  ) as unknown as TestableBridge;
  disposeAfterTest({
    dispose: () => {
      bridge.dispose();
      disposeResumeHandler();
      detachSnapshotEvents();
      session.dispose();
    },
  });
  if (!options.deferReady) await bridge.waitUntilReady();
  return bridge;
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

function shownToolEditRequestId(messages: unknown[]): string | undefined {
  for (const message of progressMessages(
    messages,
    PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
  )) {
    const update = message as ProgressMessage & {
      action?: string;
      permission?: {
        kind?: string;
        data?: { requestId?: string };
      };
    };
    if (
      update.action === 'show' &&
      update.permission?.kind === PERMISSION_KIND.TOOL_EDIT
    ) {
      return update.permission.data?.requestId;
    }
  }
  return undefined;
}

function appendRunningGroup(
  store: StreamLogStore,
  streamId: StreamTabId,
): void {
  store.append(streamId, {
    id: `${streamId}-running-group`,
    type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
    level: LOG_LEVELS.INFO,
    timestamp: 1_000,
    data: { status: STREAM_PHASE.RUNNING },
  });
}

function workflowTaskState(): WorkflowTaskState {
  return {
    agentConfig: WorkflowAgentConfigSchema.parse({
      agent: 'proofreader',
      model: 'deepseekproT',
      agentCategory: AgentCategory.Workflow,
      toolConfig: DEFAULT_TOOL_CONFIG,
    }),
    activeFiles: {
      input: false,
      context: false,
      media: false,
      output: false,
    },
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

function emitSessionFact<K extends SessionFact['type']>(
  bridge: TestableBridge,
  type: K,
  payload: Extract<SessionFact, { type: K }>['payload'],
): void {
  (bridge as BridgeWithSession).session.events.emit({
    scope: 'session',
    event: { type, payload } as Extract<SessionFact, { type: K }>,
  });
}

function emitRunEvent(
  bridge: TestableBridge,
  streamId: StreamTabId,
  event: AgentEvent,
): void {
  (bridge as BridgeWithSession).session.events.emit({
    scope: 'run',
    streamId,
    event,
  });
}

function emitRunConfigFact(
  bridge: TestableBridge,
  payload: {
    streamId: StreamTabId;
    executionId: ExecutionId;
    taskState: { agentConfig: unknown };
  },
): void {
  emitRunEvent(bridge, payload.streamId, {
    type: 'run.config',
    streamId: payload.streamId,
    executionId: payload.executionId,
    config: payload.taskState.agentConfig as AgentConfig,
  });
}

function emitStatusFact(
  bridge: TestableBridge,
  payload: {
    streamId: StreamTabId;
    status: StreamPhase;
    previousStatus?: StreamPhase;
  },
): void {
  emitRunEvent(bridge, payload.streamId, {
    type: 'status',
    streamId: payload.streamId,
    phase: payload.status,
    previousPhase: payload.previousStatus,
    cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
  });
}

describe('DesktopProgressBridge', () => {
  afterEach(() => {
    vi.doUnmock('@agent/runtime/SessionResumeRetrieval');
    vi.doUnmock('@agent/runtime/executeAgent');
    vi.doUnmock('@agent/runtime/runAgent');
    vi.doUnmock('@agent/storage/detectWaitingStreams');
    vi.doUnmock('@common/storage/KVStore');
    vi.doUnmock('@controllers/mainView/MainViewExecutionController');
    vi.doUnmock('@controllers/progressView/backend/restartRepair');
    vi.doUnmock('vscode');
    vi.restoreAllMocks();
  });

  it('routes process-session facts to the attached desktop backend', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'parent',
      agentCategory: AgentCategory.Workflow,
    });
    await settleProgressEvents();
    bridge.syncFullView();

    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({
      activeStream: 'parent',
      streams: [expect.objectContaining({ name: 'parent' })],
    });
  });

  it('leaves output-file host events to the session run-fact path', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);
    const streamId = 'desktop:output-files' as StreamTabId;
    const initialFileUpdates = progressMessages(
      messages,
      PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
    ).length;

    bridge.handleInteractionEvent('addOutputFiles', {
      streamId,
      filesByRound: {
        1: [
          {
            source: 'paper.tex',
            location: {
              kind: 'workspace',
              absolutePath: '/workspace/paper.tex',
              relativePath: 'paper.tex',
            },
            round: 1,
            lineage: null,
            diff: null,
          },
        ],
      },
    });
    await settleProgressEvents();

    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_FILES),
    ).toHaveLength(initialFileUpdates);
  });

  it('keeps desktop runtime host app events on the window-local bridge path', async () => {
    const messages: unknown[] = [];
    const showErrorMessage = vi.fn();
    const bridge = await createBridge(messages, { showErrorMessage });
    messages.length = 0;

    bridge.handleInteractionEvent('requestEnsureProgressView', {});
    bridge.handleInteractionEvent('requestEnsureProgressView', {
      fallbackNotification: {
        agentName: 'writer',
        modelName: 'test-model',
        inputName: 'paper.tex',
        outputInfo: 'to paper.out.tex',
      },
    });
    bridge.handleInteractionEvent('requestShowError', {
      message: 'Root run failed',
    });
    bridge.handleInteractionEvent('requestShowInstruction', {
      key: 'missingApiKey',
      message: 'API key not found. Set your API key in Settings and run again.',
      actions: ['set-api-key', 'open-configuration-guide'],
      showSuppress: false,
    });

    expect(messages).toContainEqual({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route: 'progress',
    });
    expect(messages).toHaveLength(1);
    expect(showErrorMessage).toHaveBeenCalledWith('Root run failed');
    // Folded into the same dialog surface as requestShowError — no second
    // subscribe surface or dialog for instructions.
    expect(showErrorMessage).toHaveBeenCalledWith(
      'API key not found. Set your API key in Settings and run again.',
    );
    expect(showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores late runtime presentation events after disposal', async () => {
    const messages: unknown[] = [];
    const showErrorMessage = vi.fn();
    const openPath = vi.fn(async () => {});
    const bridge = await createBridge(messages, {
      openPath,
      showErrorMessage,
    });

    bridge.dispose();
    messages.length = 0;
    bridge.runtimeHost.emit('requestEnsureProgressView', {});
    bridge.runtimeHost.emit('requestShowError', { message: 'late error' });
    bridge.runtimeHost.emit('requestOpenFile', {
      location: {
        kind: 'runStorage',
        absolutePath: '/workspace/late.tex',
        relativePath: 'late.tex',
      },
    });

    expect(messages).toEqual([]);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('routes requestOpenFile to the desktop preview host (issue #7751 FS3)', async () => {
    const messages: unknown[] = [];
    const openPath = vi.fn(async () => {});
    const bridge = await createBridge(messages, { openPath });

    bridge.handleInteractionEvent('requestOpenFile', {
      location: {
        kind: 'runStorage',
        absolutePath: '/runs/exec-1/output/paper.pdf',
        relativePath: 'output/paper.pdf',
        executionId: 'abc123',
      },
      preserveFocus: true,
    });
    await settleProgressEvents();

    expect(openPath).toHaveBeenCalledWith('/runs/exec-1/output/paper.pdf');
  });

  it('installs host interactions on the desktop runtime host', async () => {
    const bridge = await createBridge([]);

    expect(bridgeInteractions(bridge)).toMatchObject({
      requestPlanApproval: expect.any(Function),
      requestAgentProposal: expect.any(Function),
      requestRetry: expect.any(Function),
    });
  });

  it('resolves plan approvals through desktop host interactions', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    messages.length = 0;
    const result = bridgeInteractions(bridge).requestPlanApproval?.({
      approvalId: 'plan-host-interaction',
      streamId: 'stream-plan' as StreamTabId,
      plan: { objective: 'Check the desktop host interaction port.' },
      goalEnabled: false,
    });

    await vi.waitFor(() => {
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
      ).toContainEqual(
        expect.objectContaining({
          action: 'show',
          permission: expect.objectContaining({
            kind: PERMISSION_KIND.PLAN_APPROVAL,
            data: expect.objectContaining({
              approvalId: 'plan-host-interaction',
            }),
          }),
        }),
      );
    });

    const handlePlan = assertSupported(
      bridge.progressViewInboundHandlers[
        PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION
      ],
    );
    await handlePlan({
      command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
      approvalId: 'plan-host-interaction',
      action: 'approve',
    });

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    ).toContainEqual(
      expect.objectContaining({
        action: 'resolve',
        kind: PERMISSION_KIND.PLAN_APPROVAL,
        id: 'plan-host-interaction',
      }),
    );
  });

  it('resolves agent proposals through desktop host interactions', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    messages.length = 0;
    const result = bridgeInteractions(bridge).requestAgentProposal?.({
      proposalId: 'proposal-host-interaction',
      streamId: 'stream-proposal',
      agentCategory: AgentCategory.Workflow,
      agent: 'proofreader',
      model: 'gemini31p',
      instruction: 'Check this draft.',
      inputFiles: ['main.tex'],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: ['main.review.tex'],
      useMultipleOutputs: false,
      toolConfig: DEFAULT_TOOL_CONFIG,
    });

    await vi.waitFor(() => {
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
      ).toContainEqual(
        expect.objectContaining({
          action: 'show',
          permission: expect.objectContaining({
            kind: PERMISSION_KIND.PROPOSAL,
            data: expect.objectContaining({
              proposalId: 'proposal-host-interaction',
            }),
          }),
        }),
      );
    });

    const handleProposal = assertSupported(
      bridge.progressViewInboundHandlers[
        PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION
      ],
    );
    await handleProposal({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-host-interaction',
      action: 'approve',
    });

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    ).toContainEqual(
      expect.objectContaining({
        action: 'resolve',
        kind: PERMISSION_KIND.PROPOSAL,
        id: 'proposal-host-interaction',
      }),
    );
  });

  it('keeps desktop retry requests on the existing cancel path', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    messages.length = 0;
    await expect(
      bridgeInteractions(bridge).requestRetry?.({
        streamId: 'stream-retry' as StreamTabId,
        operation: 'model request',
      }),
    ).resolves.toEqual({ action: 'cancel' });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    ).not.toContainEqual(
      expect.objectContaining({
        action: 'show',
        permission: expect.objectContaining({
          kind: PERMISSION_KIND.RETRY,
        }),
      }),
    );
  });

  it('preserves progress and badge metadata across repeated stream syncs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'parent',
      agentCategory: AgentCategory.Workflow,
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'conversation.progress',
      progress: { toolCallCount: 5 },
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'stage.start',
      id: 'round-2',
      label: 'Round 2',
      kind: 'round',
      index: 2,
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      kind: 'processes',
      parentStreamId: 'parent',
      items: [{ kind: 'process', executionId: 'process-1', agentName: 'bash' }],
    });

    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      kind: 'subagents',
      parentStreamId: 'parent',
      items: [
        {
          kind: 'subagent',
          childStreamId: 'agent-1',
          executionId: 'agent-1',
          agentName: 'reviewer',
        },
      ],
    });
    await settleProgressEvents();
    messages.length = 0;
    bridge.syncFullView();

    const streamSync = progressMessages(
      messages,
      PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    ).at(-1);
    expect(streamSync?.streams?.find((s) => s.name === 'parent')).toMatchObject(
      {
        creationTimestamp: 1_000,
      },
    );
    expect(streamSync?.streamStates?.parent).toMatchObject({
      conversationProgress: { toolCallCount: 5 },
      roundStage: { index: 2 },
      activeSubagents: [{ executionId: 'agent-1', agentName: 'reviewer' }],
      finishedSubagentCount: 0,
      activeProcesses: [{ executionId: 'process-1', agentName: 'bash' }],
      finishedProcessCount: 0,
    });
  });

  it('accumulates finished child counts without clobbering the other active dimension', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'parent',
      agentCategory: AgentCategory.Workflow,
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      kind: 'processes',
      parentStreamId: 'parent',
      items: [{ kind: 'process', executionId: 'process-1', agentName: 'bash' }],
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      kind: 'subagents',
      parentStreamId: 'parent',
      items: [
        {
          kind: 'subagent',
          childStreamId: 'agent-1',
          executionId: 'agent-1',
          agentName: 'reviewer',
        },
      ],
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      kind: 'processes',
      parentStreamId: 'parent',
      items: [],
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      kind: 'subagents',
      parentStreamId: 'parent',
      items: [],
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
  });

  it('announces a new stream before sending its first targeted status update', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitStatusFact(bridge, {
      streamId: 'new-stream',
      status: STREAM_STATUS.RUNNING,
    });

    expect(
      messages.map((message) => (message as ProgressMessage).command),
    ).toEqual([PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA]);
    expect(
      progressMessages(
        messages,
        PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      )[0]?.streamState,
    ).toMatchObject({ status: STREAM_STATUS.RUNNING });
  });

  it('detects waiting streams from canonical execution mappings', async () => {
    const waitingStream = 'waiting-stream' as StreamTabId;
    const crashedStream = 'crashed-stream' as StreamTabId;
    const detectWaitingStreams = vi.fn(
      async (executionIds: ReadonlyMap<StreamTabId, string>) => {
        expect([...executionIds.entries()].toSorted()).toEqual([
          [crashedStream, 'def456'],
          [waitingStream, 'abc123'],
        ]);
        return new Set([waitingStream]);
      },
    );
    const bridge = await createBridge([], {
      canonicalStreamIds: [waitingStream, crashedStream],
      configureTranscripts: (store) => {
        appendRunningGroup(store, waitingStream);
        appendRunningGroup(store, crashedStream);
      },
      configureProgressSnapshotStore: (store) => {
        const taskState = TaskStateSchema.parse(workflowTaskState());
        store.setTaskState(waitingStream, taskState, 'abc123');
        store.setTaskState(crashedStream, taskState, 'def456');
      },
      detectWaitingStreams,
    });

    expect(detectWaitingStreams).toHaveBeenCalledOnce();
    expect(bridgeStatus(bridge).get(waitingStream)).toBe(STREAM_PHASE.WAITING);
    expect(bridgeStatus(bridge).get(crashedStream)).toBeUndefined();
    expect(
      bridge.streamLogs.get(waitingStream)?.getRange(0).at(-1),
    ).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: RUN_OUTCOME.CANCELLED },
    });
    expect(
      bridge.streamLogs.get(crashedStream)?.getRange(0).at(-1),
    ).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: RUN_OUTCOME.FAILED },
    });
  });

  it('starts a fresh process session on restart and repairs waiting and orphaned streams', async () => {
    const waitingStream = 'restart-waiting' as StreamTabId;
    const orphanedStream = 'restart-orphaned' as StreamTabId;
    const executionId = 'ec0e57a7' as ExecutionId;
    const kvStoreBacking = new Map<string, unknown>();
    const first = await createBridge([], { kvStoreBacking });
    const firstSession = (first as unknown as { session: SessionHandle })
      .session;
    const firstSnapshots = (
      first as unknown as {
        state: { snapshots: ProgressSnapshotStore };
      }
    ).state.snapshots;
    const taskState = workflowTaskState();

    appendRunningGroup(
      first.streamLogs as unknown as StreamLogStore,
      waitingStream,
    );
    appendRunningGroup(
      first.streamLogs as unknown as StreamLogStore,
      orphanedStream,
    );
    firstSnapshots.setTaskState(waitingStream, taskState, executionId);
    const { getExecutionStore } = await import('@agent/storage');
    await getExecutionStore(executionId).writeConfig(taskState.agentConfig);
    await firstSnapshots.flush();
    await firstSession.flushArtifacts();
    first.dispose();
    firstSession.dispose();

    const detectWaitingStreams = vi.fn(async () => new Set([waitingStream]));
    const second = await createBridge([], {
      kvStoreBacking,
      detectWaitingStreams,
    });
    const secondSession = (second as unknown as { session: SessionHandle })
      .session;

    expect(secondSession).not.toBe(firstSession);
    expect(secondSession.executions).not.toBe(firstSession.executions);
    expect(detectWaitingStreams).toHaveBeenCalledWith(
      new Map([[waitingStream, executionId]]),
    );
    expect(bridgeStatus(second).get(waitingStream)).toBe(STREAM_PHASE.WAITING);
    expect(
      second.streamLogs.get(waitingStream)?.getRange(0).at(-1),
    ).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: RUN_OUTCOME.CANCELLED },
    });
    expect(
      second.streamLogs.get(orphanedStream)?.getRange(0).at(-1),
    ).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: RUN_OUTCOME.FAILED },
    });
    await getExecutionStore(executionId).clear();
  });

  it('repairs a crashed unfinished canonical log without legacy metadata', async () => {
    const streamId = 'unfinished-stream' as StreamTabId;
    const bridge = await createBridge([], {
      canonicalStreamIds: [streamId],
      configureTranscripts: (store) => appendRunningGroup(store, streamId),
    });

    expect(bridge.streamLogs.getUnfinishedStreamIds()).toEqual([]);
    expect(bridge.streamLogs.get(streamId)?.getRange(0).at(-1)).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: RUN_OUTCOME.FAILED },
    });
    expect(bridgeStatus(bridge).get(streamId)).toBeUndefined();
  });

  it('repairs only unmapped streams when waiting detection fails', async () => {
    const unmappedStream = 'unmapped-stream' as StreamTabId;
    const mappedStream = 'mapped-stream' as StreamTabId;
    const executionId = 'ca110ad' as ExecutionId;
    const detectionError = new Error('flow records unavailable');
    const detectWaitingStreams = vi.fn(async () => {
      throw detectionError;
    });
    const bridge = await createBridge([], {
      canonicalStreamIds: [unmappedStream, mappedStream],
      configureTranscripts: (store) => {
        appendRunningGroup(store, unmappedStream);
        appendRunningGroup(store, mappedStream);
      },
      configureProgressSnapshotStore: (store) => {
        store.setTaskState(
          mappedStream,
          TaskStateSchema.parse(workflowTaskState()),
          executionId,
        );
      },
      detectWaitingStreams,
    });

    expect(detectWaitingStreams).toHaveBeenCalledOnce();
    expect(bridge.streamLogs.getUnfinishedStreamIds()).toEqual([mappedStream]);
    expect(
      bridge.streamLogs.get(unmappedStream)?.getRange(0).at(-1),
    ).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: RUN_OUTCOME.FAILED },
    });
    expect(
      bridge.streamLogs.get(mappedStream)?.getRange(0).at(-1),
    ).not.toMatchObject({ type: STREAM_LOG_ENTRY_TYPES.GROUP_END });
  });

  it('does not mask restart repair write failures as detection failures', async () => {
    const streamId = 'write-failure-stream' as StreamTabId;
    const repairError = new Error('restart repair write failed');
    const repairRestartedStreams = vi.fn(async () => {
      throw repairError;
    });

    await expect(
      createBridge([], {
        canonicalStreamIds: [streamId],
        configureTranscripts: (store) => appendRunningGroup(store, streamId),
        repairRestartedStreams,
      }),
    ).rejects.toBe(repairError);
    expect(repairRestartedStreams).toHaveBeenCalledOnce();
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
      deferReady: true,
    });
    const taskState = workflowTaskState();

    try {
      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      await settleProgressEvents();
      expect(bridge.progressViewInboundHandlers).toBeUndefined();
      expect(runAgent).not.toHaveBeenCalled();

      finishRepair(new Set());
      await bridge.waitUntilReady();

      emitRunConfigFact(bridge, {
        streamId: 'stream-new',
        executionId: 'abc123',
        taskState,
      });
      const runNew = assertSupported(
        bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW],
      );
      await runNew({
        command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
        stream: 'stream-new',
      });

      expect(runAgent).toHaveBeenCalledOnce();
    } finally {
      finishRepair(new Set());
    }
  });

  it('presents a merge failure that occurs before lifecycle startup', async () => {
    const failure = new Error('model setup failed');
    const runAgent = vi.fn(async () => {
      throw failure;
    });
    const showErrorMessage = vi.fn(async () => undefined);
    const bridge = await createBridge([], { runAgent, showErrorMessage });

    bridge.fileActions.host.startExecution({
      config: workflowTaskState().agentConfig,
    });

    await vi.waitFor(() =>
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Merge failed: model setup failed',
      ),
    );
  });

  it('leaves a terminal merge failure to the session result presenter', async () => {
    const runAgent = vi.fn(
      async (
        _request: unknown,
        options: Parameters<RunExecutionRequest>[1],
      ) => {
        await options.onRun?.({});
        throw new Error('merge execution failed');
      },
    );
    const showErrorMessage = vi.fn(async () => undefined);
    const bridge = await createBridge([], { runAgent, showErrorMessage });

    bridge.fileActions.host.startExecution({
      config: workflowTaskState().agentConfig,
    });

    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    await settleProgressEvents();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not expose the desktop bridge before transcript opening settles', async () => {
    let finishTranscriptOpen!: () => void;
    const transcriptOpenGate = new Promise<void>((resolve) => {
      finishTranscriptOpen = resolve;
    });
    const messages: unknown[] = [];
    const opening = createBridge(messages, { transcriptOpenGate });
    const opened = vi.fn();
    void opening.then(opened);
    let bridge: TestableBridge | undefined;

    try {
      await settleProgressEvents();
      expect(opened).not.toHaveBeenCalled();
      expect(messages).toEqual([]);

      finishTranscriptOpen();
      bridge = await opening;
      await bridge.completeWebviewReady();

      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS)
          .length,
      ).toBeGreaterThan(0);
    } finally {
      finishTranscriptOpen();
      bridge?.dispose();
    }
  });

  it('fails desktop bridge initialization when transcript opening fails', async () => {
    const detectWaitingStreams = vi.fn();
    const failure = new Error('stream log store unavailable');

    await expect(
      createBridge([], {
        detectWaitingStreams,
        transcriptOpenError: failure,
      }),
    ).rejects.toBe(failure);
    expect(detectWaitingStreams).not.toHaveBeenCalled();
  });

  it('loads canonical sidecars before restart repair', async () => {
    const streamId = 'canonical-stream' as StreamTabId;
    const executionId = 'ca110ad' as ExecutionId;
    let snapshots: ProgressSnapshotStore | undefined;
    const detectWaitingStreams = vi.fn(async () => {
      expect(snapshots?.getExecutionId(streamId)).toBe(executionId);
      return new Set<StreamTabId>();
    });

    const bridge = await createBridge([], {
      canonicalStreamIds: [streamId],
      configureProgressSnapshotStore: (store) => {
        snapshots = store;
        store.setTaskState(
          streamId,
          TaskStateSchema.parse(workflowTaskState()),
          executionId,
        );
      },
      detectWaitingStreams,
    });

    expect(detectWaitingStreams).toHaveBeenCalledWith(
      new Map([[streamId, executionId]]),
    );
  });

  it('subscribes before attaching and projecting process-owned live children', async () => {
    const streamId = 'attachment-order' as StreamTabId;
    const order: string[] = [];

    const bridge = await createBridge([], {
      canonicalStreamIds: [streamId],
      detectWaitingStreams: vi.fn(async () => {
        order.push('load');
        return new Set();
      }),
      configureSession: async (session) => {
        const { ProcessExecutionHandle } =
          await import('@agent/runtime/ExecutionHandle');
        session.executions.track(
          new ProcessExecutionHandle(
            'abcdef' as ExecutionId,
            streamId,
            'bash',
            () => true,
            session.interactions,
          ),
        );

        const attach = session.useHostInteractions.bind(session);
        vi.spyOn(session, 'useHostInteractions').mockImplementation(
          (interactions) => {
            expect(interactions.requestPlanApproval).toEqual(
              expect.any(Function),
            );
            order.push('attach');
            return attach(interactions);
          },
        );
        const subscribe = session.events.subscribe.bind(session.events);
        vi.spyOn(session.events, 'subscribe').mockImplementation(
          (subscriber, filter) => {
            order.push('subscribe');
            return subscribe(subscriber, filter);
          },
        );
      },
      observeRendererMessage: () => {
        order.push('render');
      },
    });
    await bridge.completeWebviewReady();

    expect(order.indexOf('load')).toBeLessThan(order.indexOf('subscribe'));
    expect(order.indexOf('subscribe')).toBeLessThan(order.indexOf('attach'));
    expect(order.indexOf('subscribe')).toBeLessThan(order.indexOf('render'));
  });

  it('rechecks active executions after waiting detection before repairing logs', async () => {
    const streamId = 'race-stream' as StreamTabId;
    const executionId = 'abc123' as ExecutionId;
    let finishDetection!: (value: Set<StreamTabId>) => void;
    const detectionGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => detectionGate);
    const bridge = await createBridge([], {
      detectWaitingStreams,
      canonicalStreamIds: [streamId],
      configureTranscripts: (store) => appendRunningGroup(store, streamId),
      configureProgressSnapshotStore: (store) => {
        store.setTaskState(
          streamId,
          TaskStateSchema.parse(workflowTaskState()),
          executionId,
        );
      },
      deferReady: true,
    });

    try {
      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      const [{ AgentExecutionHandle }, { noopAgentRuntimeHost }] =
        await Promise.all([
          import('@agent/runtime/ExecutionHandle'),
          import('@agent/runtime/AgentRuntimeHost'),
        ]);
      (bridge as BridgeWithSession).session.executions.track(
        new AgentExecutionHandle(
          executionId,
          streamId,
          streamId,
          'proofreader',
          'workflow',
          bridge.runtimeHost,
        ),
      );
      finishDetection(new Set([streamId]));
      await bridge.waitUntilReady();

      expect(bridge.streamLogs.getUnfinishedStreamIds()).toEqual([streamId]);
      expect(bridgeStatus(bridge).get(streamId)).toBeUndefined();
    } finally {
      finishDetection(new Set());
    }
  });

  it('ignores renderer switches to unknown streams', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    bridge.setActiveStream('missing-stream');

    expect(messages).toEqual([]);
  });

  it('revealStream routes to progress and selects the stream (issue #7751 FS6)', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'goal-owning-stream',
      agentCategory: AgentCategory.Workflow,
    });
    await settleProgressEvents();
    const filterStreams = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.FILTER_STREAMS],
    );
    await filterStreams({
      command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS,
      filter: 'toolUse',
    });
    messages.length = 0;

    await bridge.revealStream('goal-owning-stream');

    expect(messages).toContainEqual({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route: 'progress',
    });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
    ).toContainEqual({
      activeStream: 'goal-owning-stream',
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
    });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({
      activeStream: 'goal-owning-stream',
      agentFilter: 'all',
    });
  });

  it('revealStream keeps the current route when the stream is unknown', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    await bridge.revealStream('missing-goal-stream');

    expect(messages).toEqual([]);
  });

  it('revealStream keeps a matching filter for a canonical stream with no live session facts yet (issue #7851)', async () => {
    const messages: unknown[] = [];
    const streamId = 'persisted-tool-use-stream' as StreamTabId;
    const executionId = 'f00d123' as ExecutionId;
    const taskState = TaskStateSchema.parse({
      ...workflowTaskState(),
      agentConfig: {
        ...SEARCH_TOOL_USE_AGENT_CONFIG,
        toolConfig: DEFAULT_TOOL_CONFIG,
      },
    });
    const bridge = await createBridge(messages, {
      canonicalStreamIds: [streamId],
      kvStoreBacking: new Map<string, unknown>([
        [`executions/${executionId}/config`, taskState.agentConfig],
      ]),
      configureProgressSnapshotStore: (store) => {
        store.setTaskState(streamId, taskState, executionId);
      },
    });

    const filterStreams = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.FILTER_STREAMS],
    );
    await filterStreams({
      command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS,
      filter: 'toolUse',
    });
    messages.length = 0;

    await bridge.revealStream(streamId);

    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({
      activeStream: streamId,
      agentFilter: 'toolUse',
    });
  });

  it('reveals a goal-owned stream after persistent opening completes', async () => {
    let finishTranscriptOpen!: () => void;
    const transcriptOpenGate = new Promise<void>((resolve) => {
      finishTranscriptOpen = resolve;
    });
    const messages: unknown[] = [];
    const opening = createBridge(messages, {
      transcriptOpenGate,
      kvStoreBacking: new Map<string, unknown>([
        [
          `${STREAM_LOGS_DIR}/goal-owning-stream`,
          [
            {
              id: 'entry-1',
              text: 'restored from a prior session',
              level: LOG_LEVELS.INFO,
              timestamp: Date.now(),
            },
          ],
        ],
      ]),
    });
    const opened = vi.fn();
    void opening.then(opened);
    let bridge: TestableBridge | undefined;

    try {
      await settleProgressEvents();
      expect(opened).not.toHaveBeenCalled();
      expect(messages).toEqual([]);

      finishTranscriptOpen();
      bridge = await opening;
      await bridge.revealStream('goal-owning-stream');

      expect(messages).toContainEqual({
        command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
        route: 'progress',
      });
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
      ).toContainEqual({
        activeStream: 'goal-owning-stream',
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      });
    } finally {
      finishTranscriptOpen();
      bridge?.dispose();
    }
  });

  it('does not route to progress for suppressed background stream switches', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
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
  });

  it('emits delete-stream cleanup and flushes fallback active stream logs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'first',
      agentCategory: AgentCategory.Workflow,
    });
    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'second',
      agentCategory: AgentCategory.Workflow,
    });
    await bridge.streamLogs.ensureLoaded('first');
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
    expect(messages[2]).toMatchObject({
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      action: 'render',
      stream: 'first',
      kind: AgentCategory.Workflow,
      runUsage: {},
      outputs: { files: {}, missing: {}, compileFailures: {} },
      activeState: {
        conversationProgress: { toolCallCount: 0 },
        roundStage: null,
        badges: {
          activeSubagents: [],
          finishedSubagentCount: 0,
          activeProcesses: [],
          finishedProcessCount: 0,
        },
        parentStreamId: null,
      },
    });
    expect(messages[3]).toMatchObject({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: 'first',
      entries: [expect.objectContaining({ text: 'first stream log' })],
    });
  });

  it('resyncs a stream retained after durable cleanup fails', async () => {
    const stream = 'retained-stream' as StreamTabId;
    const messages: unknown[] = [];
    const bridge = await createBridge(messages, {
      canonicalStreamIds: [stream],
      configureProgressSnapshotStore: (store) => {
        vi.spyOn(store, 'stageDeleteStream').mockRejectedValueOnce(
          new Error('snapshot directory is locked'),
        );
      },
    });
    emitSessionFact(bridge, 'setActiveStream', {
      streamId: stream,
      agentCategory: AgentCategory.Workflow,
    });
    await settleProgressEvents();
    messages.length = 0;

    await bridge.deleteStream(stream);
    await settleProgressEvents();

    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({ activeStream: stream });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
    ).toContainEqual(expect.objectContaining({ stream }));
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
    ).toEqual([]);
  });

  it('cancels a pending plan approval instead of hanging when its stream is deleted', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'plan-delete-stream',
      agentCategory: AgentCategory.Workflow,
    });

    const result = bridgeInteractions(bridge).requestPlanApproval?.({
      approvalId: 'plan-cancel-on-delete',
      streamId: 'plan-delete-stream' as StreamTabId,
      plan: { objective: 'Check cancellation on stream delete.' },
      goalEnabled: false,
    });

    await vi.waitFor(() => {
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
      ).toContainEqual(
        expect.objectContaining({
          action: 'show',
          permission: expect.objectContaining({
            kind: PERMISSION_KIND.PLAN_APPROVAL,
            data: expect.objectContaining({
              approvalId: 'plan-cancel-on-delete',
            }),
          }),
        }),
      );
    });

    await bridge.deleteStream('plan-delete-stream' as StreamTabId);

    // This promise must settle through releaseStreamResources, which owns
    // stream-scoped interaction cleanup.
    await expect(result).resolves.toEqual({
      action: 'reject',
      feedback: 'Stream resources released.',
    });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    ).toContainEqual(
      expect.objectContaining({
        action: 'resolve',
        kind: PERMISSION_KIND.PLAN_APPROVAL,
        id: 'plan-cancel-on-delete',
      }),
    );
  });

  it('does not resume a stream deleted in this desktop session', async () => {
    const taskState = { agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG };
    const retrieveSessionResumeData = vi.fn(async () =>
      createToolUseResumeData({
        executionId: 'ec1001' as ExecutionId,
        streamId: 'stream-1' as StreamTabId,
        agentConfig: taskState.agentConfig,
      }),
    );
    const bridge = await createBridge([], {
      canonicalStreamIds: ['stream-1'],
      retrieveSessionResumeData,
    });

    (bridge as BridgeWithSession).session.events.emit({
      scope: 'run',
      streamId: 'stream-1',
      event: {
        type: 'run.config',
        streamId: 'stream-1',
        executionId: 'ec1001',
        config: taskState.agentConfig,
      } as any,
    });

    await bridge.deleteStream('stream-1');
    (bridge as BridgeWithSession).session.events.emit({
      scope: 'run',
      streamId: 'stream-1',
      event: {
        type: 'run.config',
        streamId: 'stream-1',
        executionId: 'ec1001',
        config: taskState.agentConfig,
      } as any,
    });
    await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('forgets desktop goal records when deleting a stream', async () => {
    const stream = 'goal-stream' as StreamTabId;
    const bridge = await createBridge([]);
    const { GoalStore: bridgeGoalStore } = await import('@tools/goal');
    await bridgeGoalStore.forget(stream);
    await bridgeGoalStore.start(stream, 'finish the cleanup');

    try {
      emitSessionFact(bridge, 'setActiveStream', {
        streamId: stream,
        agentCategory: AgentCategory.Workflow,
      });

      await bridge.deleteStream(stream);

      expect(bridgeGoalStore.getForStream(stream)).toBeNull();
    } finally {
      await bridgeGoalStore.forget(stream);
    }
  });

  it('preserves renderer stream switches that land during active stream deletion', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'first',
      agentCategory: AgentCategory.Workflow,
    });
    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'second',
      agentCategory: AgentCategory.Workflow,
    });
    emitSessionFact(bridge, 'setActiveStream', {
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
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({
      activeStream: 'third',
    });
  });

  it('falls back if a deleted stream is reactivated during deletion', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'first',
      agentCategory: AgentCategory.Workflow,
    });
    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'second',
      agentCategory: AgentCategory.Workflow,
    });
    await settleProgressEvents();
    bridge.setActiveStream('first');
    messages.length = 0;

    const deletePromise = bridge.deleteStream('second');
    emitSessionFact(bridge, 'setActiveStream', {
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
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({
      activeStream: 'first',
    });
  });

  it('emits delete-all cleanup before syncing an empty stream list', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);
    const cancel = vi.spyOn(
      (bridge as BridgeWithSession).session.interactions,
      'cancel',
    );

    emitSessionFact(bridge, 'setActiveStream', {
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
    expect(cancel).toHaveBeenCalledWith({ cause: 'All streams deleted.' });
  });

  it('syncs an inactive stream retained by bulk deletion', async () => {
    const deletedStream = 'deleted-stream' as StreamTabId;
    const retainedStream = 'retained-stream' as StreamTabId;
    const messages: unknown[] = [];
    const bridge = await createBridge(messages, {
      canonicalStreamIds: [deletedStream, retainedStream],
      configureProgressSnapshotStore: (store) => {
        const stageSnapshotDelete = store.stageDeleteStream.bind(store);
        vi.spyOn(store, 'stageDeleteStream').mockImplementation(
          async (stream) => {
            if (stream === retainedStream) {
              throw new Error('snapshot directory is locked');
            }
            return stageSnapshotDelete(stream);
          },
        );
      },
    });
    bridge.setActiveStream(deletedStream);
    messages.length = 0;

    await bridge.deleteAllStreams();
    await settleProgressEvents();

    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(-1),
    ).toMatchObject({ activeStream: retainedStream });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
    ).toContainEqual(expect.objectContaining({ stream: retainedStream }));
  });

  it('cancels a pending bash approval instead of hanging when all streams are deleted', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitSessionFact(bridge, 'setActiveStream', {
      streamId: 'bash-delete-all-stream',
      agentCategory: AgentCategory.Workflow,
    });

    const result = bridgeInteractions(bridge).requestBashApproval?.({
      command: 'echo hi',
      streamId: 'bash-delete-all-stream' as StreamTabId,
    });

    await vi.waitFor(() => {
      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
      ).toContainEqual(
        expect.objectContaining({
          action: 'show',
          permission: expect.objectContaining({
            kind: PERMISSION_KIND.BASH,
          }),
        }),
      );
    });

    await bridge.deleteAllStreams();

    // This promise must settle through releaseStreamResources, which owns
    // stream-scoped interaction cleanup.
    await expect(result).resolves.toEqual({
      accepted: false,
      userMessage: 'Stream resources released.',
    });
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
      canonicalStreamIds: ['stream-1'],
    });

    try {
      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(true);
      expect(kvRead).toHaveBeenCalledWith('meta');
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        executionId,
        expect.objectContaining(taskState.agentConfig),
        { parentStreamId: undefined },
      );
      expectWorkflowResume(runAgent, taskState, executionId);
    } finally {
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('runs a fresh stream through the shared workflow-actions controller', async () => {
    const taskState = workflowTaskState();
    const runAgent = vi.fn(async () => {});
    const bridge = await createBridge([], { runAgent });

    emitRunConfigFact(bridge, {
      streamId: 'stream-new',
      executionId: 'exec-new',
      taskState,
    });

    const runNew = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW],
    );
    expect(runNew).toBeTypeOf('function');
    await runNew({
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
  });

  it('resumes canonical streams using sidecar execution ids', async () => {
    const executionId = 'abc123';
    const streamId = 'stream-1' as StreamTabId;
    const taskState = workflowTaskState();
    const retrieveSessionResumeData = vi.fn(async () => ({
      type: 'workflow',
      agentConfig: taskState.agentConfig,
      executionId,
    }));
    const runAgent = vi.fn(async () => {});
    let snapshots: ProgressSnapshotStore | undefined;
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      runAgent,
      canonicalStreamIds: [streamId],
      kvStoreBacking: new Map<string, unknown>([
        [`executions/${executionId}/config`, taskState.agentConfig],
      ]),
      configureProgressSnapshotStore: (store) => {
        snapshots = store;
        store.setTaskState(
          streamId,
          TaskStateSchema.parse(taskState),
          executionId,
        );
        store.setDescription(streamId, 'Persisted workflow');
      },
    });

    try {
      expect(snapshots?.getExecutionId(streamId)).toBe(executionId);
      expect(snapshots?.getRunConfig(streamId)).toMatchObject(
        taskState.agentConfig,
      );
      await expect(bridge.tryResumeStream(streamId)).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        streamId,
        executionId,
        expect.objectContaining(taskState.agentConfig),
        { parentStreamId: undefined },
      );
      expectWorkflowResume(runAgent, taskState, executionId);
    } finally {
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('resumes tool-use streams through the shared snapshot path', async () => {
    const parentStreamId = 'stream-parent' as StreamTabId;
    const retrieveSessionResumeData = vi.fn(
      async (
        _streamId: StreamTabId,
        _executionId: string,
        _runState: unknown,
        options?: { parentStreamId?: StreamTabId },
      ) =>
        createToolUseResumeData({
          executionId: 'ec1001' as ExecutionId,
          streamId: 'stream-1' as StreamTabId,
          agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG,
          ...(options?.parentStreamId !== undefined && {
            parentStreamId: options.parentStreamId,
          }),
        }),
    );
    const resumeToolUseFromResumeData = vi.fn(async (...args: unknown[]) => {
      const options = args[2] as { onFollowUpConsumed?: () => void };
      options.onFollowUpConsumed?.();
    });
    const messages: unknown[] = [];
    const bridge = await createBridge(messages, {
      retrieveSessionResumeData,
      resumeToolUseFromResumeData,
      canonicalStreamIds: ['stream-1'],
    });
    const taskState = { agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG };

    try {
      emitRunConfigFact(bridge, {
        streamId: 'stream-1',
        executionId: 'ec1001' as ExecutionId,
        taskState,
      });
      emitSessionFact(bridge, 'setParentStream', {
        childStreamId: 'stream-1',
        parentStreamId,
      });
      bridgeFollowUps(bridge).enqueue(
        'stream-1',
        { text: 'queued follow-up' },
        { force: true },
      );

      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        'ec1001',
        taskState.agentConfig,
        { parentStreamId },
      );
      expect(resumeToolUseFromResumeData).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'ec1001',
          streamId: 'stream-1',
          parentStreamId,
        }),
        expect.objectContaining({ emit: expect.any(Function) }),
        expect.objectContaining({
          takePendingFollowUps: expect.any(Function),
        }),
      );
      const [, , resumeOptions] = resumeToolUseFromResumeData.mock
        .calls[0] as unknown as [
        unknown,
        unknown,
        {
          drainedFollowUps?: readonly { text: string; origin?: string }[];
          takePendingFollowUps(): readonly { text: string; origin?: string }[];
        },
      ];
      // The drained batch travels via the direct drainedFollowUps handoff (a
      // subagent's WAITING cursor never reads the stream queue). The attachment
      // drain closes the only race before later input can target the live flow.
      expect(resumeOptions.drainedFollowUps?.map((item) => item.text)).toEqual([
        'queued follow-up',
      ]);
      expect(resumeOptions.takePendingFollowUps()).toEqual([]);
    } finally {
      bridgeFollowUps(bridge).release('stream-1');
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('keeps queued follow-ups when tool-use resume fails', async () => {
    const retrieveSessionResumeData = vi.fn(async () =>
      createToolUseResumeData({
        executionId: 'ec1001' as ExecutionId,
        streamId: 'stream-1' as StreamTabId,
        agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG,
      }),
    );
    const resumeToolUseFromResumeData = vi.fn(async () => {
      throw new Error('resume failed');
    });
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      resumeToolUseFromResumeData,
      canonicalStreamIds: ['stream-1'],
    });

    try {
      emitRunConfigFact(bridge, {
        streamId: 'stream-1',
        executionId: 'ec1001' as ExecutionId,
        taskState: { agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG },
      });
      bridgeFollowUps(bridge).enqueue(
        'stream-1',
        { text: 'queued follow-up' },
        { force: true },
      );

      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      expect(bridgeFollowUps(bridge).getAll('stream-1')).toEqual([
        'queued follow-up',
      ]);
      expect(bridgeStatus(bridge).get('stream-1')).toBe(STREAM_STATUS.WAITING);
    } finally {
      bridgeFollowUps(bridge).release('stream-1');
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('does not launch a duplicate resume for active streams', async () => {
    const retrieveSessionResumeData = vi.fn(async () => null);
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      canonicalStreamIds: ['stream-1'],
    });

    try {
      seedStreamStatusForTest(
        bridgeStatus(bridge),
        'stream-1',
        STREAM_STATUS.RUNNING,
      );

      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      expect(retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      bridgeStatus(bridge).clearStream('stream-1');
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
      return createToolUseResumeData({
        executionId: 'ec1001' as ExecutionId,
        streamId: 'stream-1' as StreamTabId,
        agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG,
      });
    });
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      canonicalStreamIds: ['stream-1'],
    });

    try {
      emitRunConfigFact(bridge, {
        streamId: 'stream-1',
        executionId: 'ec1001' as ExecutionId,
        taskState: { agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG },
      });

      const firstResume = bridge.tryResumeStream('stream-1');
      await retrieveStartedPromise;
      await expect(bridge.tryResumeStream('stream-1')).resolves.toBe(false);
      allowRetrieve();
      await expect(firstResume).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledTimes(1);
    } finally {
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('restores agent proposal setup into the desktop launcher', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    // Register the pending proposal the way production does: through the
    // session's typed host interactions, not a host progress event.
    const result = bridgeInteractions(bridge).requestAgentProposal?.({
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
    // The port now emits the ensure-view/activation events the coordinator
    // layer used to duplicate; settle them before snapshotting messages.
    await settleProgressEvents();
    messages.length = 0;

    const handleProposal = assertSupported(
      bridge.progressViewInboundHandlers[
        PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION
      ],
    );
    expect(handleProposal).toBeTypeOf('function');
    await handleProposal({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'setup',
    });

    await expect(result).resolves.toEqual({ action: 'setup' });
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
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
        action: 'resolve',
        kind: PERMISSION_KIND.PROPOSAL,
        id: 'proposal-1',
      }),
    ]);
  });

  it("restores a stream's task state into the main view (history 'Setup' / Progress board restore)", async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    emitRunConfigFact(bridge, {
      streamId: 'stream-1',
      executionId: 'ec1002' as ExecutionId,
      taskState: { agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG },
    });
    await settleProgressEvents();
    messages.length = 0;

    const handleRestoreState = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RESTORE_STATE],
    );
    expect(handleRestoreState).toBeTypeOf('function');
    await handleRestoreState({
      command: PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
      stream: 'stream-1',
    });

    expect(messages).toEqual([
      { command: DESKTOP_SHELL_COMMANDS.SET_ROUTE, route: 'main' },
      expect.objectContaining({ command: COMMON_COMMANDS.STATE_RESTORE }),
    ]);
  });

  it('ignores restoreState for a stream with no persisted task state', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    const handleRestoreState = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RESTORE_STATE],
    );
    await handleRestoreState({
      command: PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
      stream: 'stream-unknown',
    });

    expect(messages).toEqual([]);
  });

  it('surfaces an error when restoreState fails to build main-view state (cursor[bot] #7827)', async () => {
    const messages: unknown[] = [];
    const errors: string[] = [];
    const loggerErrorSpy = vi.fn<AgentTrace['error']>();
    const bridge = await createBridge(messages, {
      showErrorMessage: async (message) => {
        errors.push(message);
      },
      loggerErrorSpy,
    });

    // inputFiles must be string[]; a non-array value makes
    // MainViewPersistedStateSchema.parse() inside buildMainViewState throw,
    // so restoreTaskState() returns false and the handler must surface it
    // instead of silently doing nothing (unlike the extension's
    // texra.restoreState, which shows RESTORE_MALFORMED_MESSAGE).
    emitRunConfigFact(bridge, {
      streamId: 'stream-1',
      executionId: 'ec1003' as ExecutionId,
      taskState: {
        agentConfig: {
          ...SEARCH_TOOL_USE_AGENT_CONFIG,
          inputFiles: 12345,
        },
      },
    });
    await settleProgressEvents();
    messages.length = 0;

    const handleRestoreState = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RESTORE_STATE],
    );
    await handleRestoreState({
      command: PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
      stream: 'stream-1',
    });

    expect(messages).toEqual([]);
    expect(errors).toEqual(['Failed to restore state']);
    // #7860: the caught buildMainViewState() error must be logged, not
    // silently discarded, even though the user-facing message is unchanged.
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Failed to build main-view state for restore',
      { data: expect.anything() },
    );
  });

  it('flushes debounced stream logs before shutdown can drop them', async () => {
    const streamId = 'shutdown-flush' as StreamTabId;
    const kvStoreBacking = new Map<string, unknown>();
    const bridge = await createBridge([], { kvStoreBacking });

    bridge.streamLogs.append(streamId, {
      id: 'shutdown-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      text: 'persist me before quit',
    });

    await (
      bridge as unknown as { session: SessionHandle }
    ).session.flushArtifacts();
    bridge.streamLogs.releaseEntries(streamId);
    await bridge.streamLogs.reload();
    await bridge.streamLogs.ensureLoaded(streamId);

    expect(
      bridge.streamLogs
        .get(streamId)
        ?.getRange(0)
        .map((entry) => entry.text),
    ).toEqual(['persist me before quit']);
  });

  // One Electron process owns the session continuously; BrowserWindows own
  // only presentation resources that attach and detach from it.
  describe('process-owned session across window recreation', () => {
    async function createProcessOwner({
      streamId,
      executionId,
      agentName = 'proofreader',
      category = AgentCategory.Workflow,
      messages = [],
      detectWaitingStreams,
      wakeQueuedFollowUpStream,
    }: {
      streamId: StreamTabId;
      executionId: ExecutionId;
      agentName?: string;
      category?: AgentCategory;
      messages?: unknown[];
      detectWaitingStreams?: ReturnType<typeof vi.fn>;
      wakeQueuedFollowUpStream?: ReturnType<typeof vi.fn>;
    }) {
      const {
        bridgeModule,
        createProgressSnapshotStore,
        createSession,
        openTranscripts,
        processResumeOwner,
      } = await loadBridgeModule({
        detectWaitingStreams,
        wakeQueuedFollowUpStream,
      });
      const { AgentExecutionHandle, ProcessExecutionHandle } =
        await import('@agent/runtime/ExecutionHandle');
      const { getExecutionStore } = await import('@agent/storage');
      const { noopAgentRuntimeHost } =
        await import('@agent/runtime/AgentRuntimeHost');
      const transcripts = await openTranscripts();
      transcripts.ensureStream(streamId);
      await transcripts.flush();
      const processSession = createSession(transcripts);
      const { initializeDesktopProcessStores } =
        await import('@desktop/main/desktopLegacyStreamImporter');
      const progressSnapshotStore = createProgressSnapshotStore();
      const processStores = await initializeDesktopProcessStores({
        session: processSession,
        snapshots: progressSnapshotStore,
      });
      const { stores: sessionStores } = processStores;
      const disposeResumeHandler = processResumeOwner.attach({
        session: processSession,
        snapshots: progressSnapshotStore,
      });
      const taskState = workflowTaskState();
      progressSnapshotStore.setTaskState(
        streamId,
        TaskStateSchema.parse({
          ...taskState,
          agentConfig: {
            ...taskState.agentConfig,
            agent: agentName,
            agentCategory: category,
          },
        }),
        executionId,
      );
      const errorsA: string[] = [];
      const infosA: string[] = [];
      const diffPathsA: Array<{ original: string; proposed: string }> = [];
      const bridgeA = new bridgeModule.DesktopProgressBridge(
        (message) => {
          messages.push(message);
        },
        {
          session: processSession,
          sessionStores,
          progressSnapshotStore,
          host: createStubDesktopAgentExecutionHost({
            openDiff: async (original, proposed, title) => {
              diffPathsA.push({
                original: original.filePath,
                proposed: proposed.filePath,
              });
              return { original, proposed, title };
            },
            showErrorMessage: async (message) => {
              errorsA.push(message);
            },
            showInfoMessage: async (message) => {
              infosA.push(message);
            },
          }),
        },
      ) as unknown as TestableBridge & { session: SessionHandle };
      await bridgeA.waitUntilReady();
      const presentationBridges = new Set([bridgeA]);
      const createHandle = (
        options: {
          executionId?: ExecutionId;
          parentStreamId?: StreamTabId;
          childStreamId?: StreamTabId;
          agentName?: string;
          category?: AgentCategory;
        } = {},
      ) => {
        const nextTrace = makeFakeTrace();
        const nextHandle = new AgentExecutionHandle(
          options.executionId ?? executionId,
          options.parentStreamId ?? streamId,
          options.childStreamId ?? streamId,
          options.agentName ?? agentName,
          options.category ?? category,
          processSession.interactions,
          nextTrace as unknown as ConstructorParameters<
            typeof AgentExecutionHandle
          >[6],
        );
        processSession.attachRunTrace(
          nextTrace as unknown as AgentTrace,
          options.childStreamId ?? streamId,
        );
        return { handle: nextHandle, trace: nextTrace };
      };
      const { handle, trace } = createHandle();
      processSession.executions.trackAgentExecution(handle, {
        status: STREAM_PHASE.RUNNING,
      });
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        bridgeA.dispose();
      };

      const reopen = async (reopenedMessages: unknown[] = []) => {
        close();
        const errorsB: string[] = [];
        const infosB: string[] = [];
        const bridgeB = new bridgeModule.DesktopProgressBridge(
          (message) => {
            reopenedMessages.push(message);
          },
          {
            session: processSession,
            sessionStores,
            progressSnapshotStore,
            host: createStubDesktopAgentExecutionHost({
              showErrorMessage: async (message) => {
                errorsB.push(message);
              },
              showInfoMessage: async (message) => {
                infosB.push(message);
              },
            }),
          },
        ) as unknown as TestableBridge & {
          session: SessionHandle;
        };
        presentationBridges.add(bridgeB);
        await bridgeB.waitUntilReady();
        return { bridgeB, errorsB, infosB, progressSnapshotStore };
      };

      disposeAfterTest({
        dispose: () => {
          for (const bridge of presentationBridges) bridge.dispose();
          disposeResumeHandler();
          processStores.dispose();
          processSession.dispose();
        },
      });

      return {
        ProcessExecutionHandle,
        bridgeA,
        close,
        createHandle,
        errorsA,
        infosA,
        diffPathsA,
        getExecutionStore,
        handle,
        noopAgentRuntimeHost,
        processSession,
        progressSnapshotStore,
        sessionStores,
        reopen,
        trace,
      };
    }

    it('keeps a live transcript append made while replacement state loads', async () => {
      const streamId = 'process-stream-live-reopen' as StreamTabId;
      const childStreamId = 'process-child-live-reopen' as StreamTabId;
      const executionId = 'ec00dc' as ExecutionId;
      const childExecutionId = 'ec00db' as ExecutionId;
      let releaseSnapshotLoad!: () => void;
      let markSnapshotLoadStarted!: () => void;
      const snapshotLoadStarted = new Promise<void>((resolve) => {
        markSnapshotLoadStarted = resolve;
      });
      const snapshotLoadGate = new Promise<void>((resolve) => {
        releaseSnapshotLoad = resolve;
      });
      let repairCallCount = 0;
      const detectWaitingStreams = vi.fn(async () => {
        repairCallCount += 1;
        if (repairCallCount === 2) {
          markSnapshotLoadStarted();
          await snapshotLoadGate;
        }
        return new Set<StreamTabId>();
      });
      const owner = await createProcessOwner({
        streamId,
        executionId,
        detectWaitingStreams,
      });
      owner.close();
      const pendingApproval =
        owner.processSession.interactions.requestPlanApproval?.({
          approvalId: 'approval-during-reopen-load',
          streamId,
          plan: { objective: 'Wait for canonical state.' },
          goalEnabled: false,
        });
      const messagesB: unknown[] = [];
      const reopening = owner.reopen(messagesB);
      await snapshotLoadStarted;
      expect(
        progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
      ).toEqual([]);
      owner.processSession.transcripts.append(streamId, {
        id: 'during-reopen',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 2_500,
        text: 'Appended while replacement presentation loaded.',
      });
      owner.processSession.transcripts.ensureStream(childStreamId);
      owner.processSession.publishRunEvent(childStreamId, {
        type: 'run.config',
        streamId: childStreamId,
        executionId: childExecutionId,
        config: SEARCH_TOOL_USE_AGENT_CONFIG,
      });
      owner.processSession.events.emit({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: { childStreamId, parentStreamId: streamId },
        },
      });
      owner.processSession.events.emit({
        scope: 'session',
        event: {
          type: 'updateStreamDescription',
          payload: {
            streamId: childStreamId,
            description: 'Metadata emitted during attachment.',
          },
        },
      });
      owner.processSession.publishRunEvent(childStreamId, {
        type: 'usage',
        payload: {
          streamId: childStreamId,
          storageKey: childExecutionId as StorageKey,
          usage: { inputTokens: 5, outputTokens: 2, cost: 0.01 },
        },
      });
      releaseSnapshotLoad();
      const { bridgeB } = await reopening;

      try {
        bridgeB.syncFullView();
        await vi.waitFor(() => {
          expect(
            progressMessages(
              messagesB,
              PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
            ).filter(
              (message) =>
                (
                  message as ProgressMessage & {
                    permission?: { data?: { approvalId?: string } };
                  }
                ).permission?.data?.approvalId ===
                'approval-during-reopen-load',
            ),
          ).toHaveLength(1);
        });
        expect(
          owner.progressSnapshotStore.getRunConfig(childStreamId)?.agent,
        ).toBe('search');
        expect(
          owner.progressSnapshotStore.getParentStreamId(childStreamId),
        ).toBe(streamId);
        expect(
          progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
            -1,
          ),
        ).toMatchObject({
          streams: expect.arrayContaining([
            expect.objectContaining({
              name: childStreamId,
              agent: 'search',
              agentCategory: AgentCategory.ToolUse,
              parentStreamId: streamId,
              description: 'Metadata emitted during attachment.',
            }),
            expect.objectContaining({ name: streamId }),
          ]),
        });
        expect(
          owner.progressSnapshotStore
            .getRunUsage(childStreamId)
            .get(childExecutionId),
        ).toMatchObject({ inputTokens: 5, outputTokens: 2, cost: 0.01 });
        expect(
          bridgeB.streamLogs
            .get(streamId)
            ?.getRange(0)
            .map((entry) => entry.text),
        ).toContain('Appended while replacement presentation loaded.');
        expect(
          bridgeB.hostInteractions.submitPlanDecision(
            'approval-during-reopen-load',
            { action: 'approve' },
          ),
        ).toBe(true);
        await expect(pendingApproval).resolves.toEqual({ action: 'approve' });
      } finally {
        bridgeB.dispose();
      }
    });

    it('reattaches process-session interactions to the reopened window exactly once (#8227)', async () => {
      const streamId = 'rebound-stream-3' as StreamTabId;
      const executionId = 'ec00ee' as ExecutionId;
      const messagesA: unknown[] = [];
      const owner = await createProcessOwner({
        streamId,
        executionId,
        messages: messagesA,
      });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        bridgeB.syncFullView();
        await bridgeB.completeWebviewReady();

        // The retained run still owns one process-session interaction.
        const planPromise = bridgeInteractions(
          owner.bridgeA,
        ).requestPlanApproval?.({
          approvalId: 'plan-rebound',
          streamId,
          plan: { objective: 'Prove approvals reach the new window.' },
          goalEnabled: false,
        });
        expect(planPromise).toBeDefined();

        // Its presentation moves to the currently attached window.
        await vi.waitFor(() => {
          expect(
            progressMessages(
              messagesB,
              PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
            ),
          ).toContainEqual(
            expect.objectContaining({
              action: 'show',
              permission: expect.objectContaining({
                kind: PERMISSION_KIND.PLAN_APPROVAL,
                data: expect.objectContaining({ approvalId: 'plan-rebound' }),
              }),
            }),
          );
        });
        expect(
          progressMessages(messagesA, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
        ).toEqual([]);

        // The detached presenter cannot settle the request; the attached one can.
        expect(
          owner.bridgeA.hostInteractions.submitPlanDecision('plan-rebound', {
            action: 'approve',
          }),
        ).toBe(false);
        expect(
          bridgeB.hostInteractions.submitPlanDecision('plan-rebound', {
            action: 'approve',
          }),
        ).toBe(true);
        await expect(planPromise).resolves.toEqual({ action: 'approve' });
      } finally {
        bridgeB.dispose();
      }
    });

    it('replays a follow-up wake notice that completes after window close exactly once', async () => {
      const streamId = 'process-follow-up-wake' as StreamTabId;
      const executionId = 'ec00ea' as ExecutionId;
      let finishWake: (result: { kind: 'dropped' }) => void = () => undefined;
      const wakeResult = new Promise<{ kind: 'dropped' }>((resolve) => {
        finishWake = resolve;
      });
      const wakeQueuedFollowUpStream = vi.fn(() => wakeResult);
      const owner = await createProcessOwner({
        streamId,
        executionId,
        agentName: 'search',
        category: AgentCategory.ToolUse,
        wakeQueuedFollowUpStream,
      });
      expect(
        owner.processSession.status.transitionToWaiting(streamId, 'wait', {
          trace: owner.trace as unknown as AgentTrace,
        }),
      ).toBe(true);
      const send = assertSupported(
        owner.bridgeA.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP
        ],
      );

      await send({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        stream: streamId,
        text: 'Continue after the child completes.',
      });
      expect(wakeQueuedFollowUpStream).toHaveBeenCalledOnce();
      owner.close();
      finishWake({ kind: 'dropped' });
      await settleProgressEvents();
      expect(owner.infosA).toEqual([]);

      const { bridgeB, infosB } = await owner.reopen();
      try {
        await vi.waitFor(() =>
          expect(infosB).toEqual([
            'Message dropped because no session was available to receive it. Start a new agent task to continue.',
          ]),
        );
        await settleProgressEvents();
        expect(infosB).toHaveLength(1);
      } finally {
        bridgeB.dispose();
      }

      const { bridgeB: bridgeC, infosB: infosC } = await owner.reopen();
      try {
        await settleProgressEvents();
        expect(infosC).toEqual([]);
      } finally {
        bridgeC.dispose();
      }
    });

    it('routes a retained handle runtime event only to the current presentation', async () => {
      const streamId = 'process-runtime-host' as StreamTabId;
      const executionId = 'ec00de' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB, errorsB } = await owner.reopen();

      try {
        expect(owner.handle.runtimeHost).toBe(
          owner.processSession.interactions,
        );
        owner.handle.runtimeHost.emit('requestShowError', {
          message: 'Presented after reopen.',
        });
        await vi.waitFor(() =>
          expect(errorsB).toEqual(['Presented after reopen.']),
        );
        expect(owner.errorsA).toEqual([]);
      } finally {
        bridgeB.dispose();
      }
    });

    it('replays one terminal error produced while no window is attached', async () => {
      const streamId = 'process-headless-result' as StreamTabId;
      const executionId = 'ec00df' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      owner.close();

      owner.trace.emit({
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
        executionId,
        streamId,
        agentName: 'proofreader',
        category: 'workflow',
        isSubagent: false,
        error: {
          kind: 'unexpected',
          message: 'Failure while desktop was headless.',
        },
      });
      expect(owner.errorsA).toEqual([]);

      const { bridgeB, errorsB } = await owner.reopen();
      try {
        await vi.waitFor(() =>
          expect(errorsB).toEqual(['Failure while desktop was headless.']),
        );
        await Promise.resolve();
        expect(errorsB).toHaveLength(1);
        expect(owner.errorsA).toEqual([]);
      } finally {
        bridgeB.dispose();
      }
    });

    it('replays a tool-edit approval with a fresh window request id', async () => {
      const streamId = 'rebound-stream-tool-edit' as StreamTabId;
      const executionId = 'ec00ed' as ExecutionId;
      const messagesA: unknown[] = [];
      const owner = await createProcessOwner({
        streamId,
        executionId,
        messages: messagesA,
      });
      const approvalPromise = bridgeInteractions(
        owner.bridgeA,
      ).requestToolEditApproval?.({
        path: '/workspace/rebound-tool-edit.txt',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
        streamId,
      });
      expect(approvalPromise).toBeDefined();
      let oldRequestId = '';
      await vi.waitFor(() => {
        oldRequestId = shownToolEditRequestId(messagesA) ?? '';
        expect(oldRequestId).not.toBe('');
      });
      const handleOldToolEdit = assertSupported(
        owner.bridgeA.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
        ],
      );
      await handleOldToolEdit({
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: oldRequestId,
        action: 'openDiff',
      });
      await vi.waitFor(() => expect(owner.diffPathsA).toHaveLength(1));
      const [oldDiff] = owner.diffPathsA;
      await expect(access(oldDiff!.original)).resolves.toBeUndefined();
      await expect(access(oldDiff!.proposed)).resolves.toBeUndefined();

      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);
      try {
        await vi.waitFor(async () => {
          await expect(access(oldDiff!.original)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(access(oldDiff!.proposed)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        });
        let newRequestId = '';
        await vi.waitFor(() => {
          newRequestId = shownToolEditRequestId(messagesB) ?? '';
          expect(newRequestId).not.toBe('');
        });
        expect(newRequestId).not.toBe(oldRequestId);

        let settledByOldPresenter = false;
        void approvalPromise?.then(() => {
          settledByOldPresenter = true;
        });
        await handleOldToolEdit({
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: oldRequestId,
          action: 'reject',
          feedback: 'Stale presenter.',
        });
        await settleProgressEvents();
        expect(settledByOldPresenter).toBe(false);

        const handleToolEdit = assertSupported(
          bridgeB.progressViewInboundHandlers[
            PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
          ],
        );
        await handleToolEdit({
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: newRequestId,
          action: 'reject',
          feedback: 'Not this edit.',
        });

        await expect(approvalPromise).resolves.toMatchObject({
          accepted: false,
          userMessage: 'Not this edit.',
        });
      } finally {
        bridgeB.dispose();
      }
    });

    it('keeps owner approvals pending when a replacement window also closes', async () => {
      const streamId = 'rebound-stream-second-close' as StreamTabId;
      const executionId = 'ec00ec' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      const approval = bridgeInteractions(owner.bridgeA).requestPlanApproval?.({
        approvalId: 'plan-second-window-close',
        streamId,
        plan: { objective: 'Survive a second window close.' },
        goalEnabled: false,
      });
      expect(approval).toBeDefined();
      await vi.waitFor(() => {
        expect(
          progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
        ).toContainEqual(
          expect.objectContaining({
            action: 'show',
            permission: expect.objectContaining({
              data: expect.objectContaining({
                approvalId: 'plan-second-window-close',
              }),
            }),
          }),
        );
      });

      const staleInteractionsB = bridgeB.hostInteractions;
      bridgeB.dispose();
      const messagesC: unknown[] = [];
      const { bridgeB: bridgeC } = await owner.reopen(messagesC);
      try {
        await bridgeC.waitUntilReady();
        await vi.waitFor(() => {
          expect(
            progressMessages(
              messagesC,
              PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
            ),
          ).toContainEqual(
            expect.objectContaining({
              action: 'show',
              permission: expect.objectContaining({
                data: expect.objectContaining({
                  approvalId: 'plan-second-window-close',
                }),
              }),
            }),
          );
        });
        let settled = false;
        void approval?.then(() => {
          settled = true;
        });
        expect(
          staleInteractionsB.submitPlanDecision('plan-second-window-close', {
            action: 'approve',
          }),
        ).toBe(false);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(
          bridgeC.hostInteractions.submitPlanDecision(
            'plan-second-window-close',
            { action: 'approve' },
          ),
        ).toBe(true);
        await expect(approval).resolves.toEqual({ action: 'approve' });
      } finally {
        bridgeC.dispose();
      }
    });

    it('replays approvals requested before close and while awaiting reopen repair (#8261)', async () => {
      const streamId = 'rebound-stream-approval-gap' as StreamTabId;
      const executionId = 'ec00ef' as ExecutionId;
      const messagesA: unknown[] = [];
      const owner = await createProcessOwner({
        streamId,
        executionId,
        messages: messagesA,
      });
      const pendingBeforeClose = bridgeInteractions(
        owner.bridgeA,
      ).requestPlanApproval?.({
        approvalId: 'plan-before-close',
        streamId,
        plan: { objective: 'Preserve the pending approval.' },
        goalEnabled: false,
      });
      expect(pendingBeforeClose).toBeDefined();
      await vi.waitFor(() => {
        expect(
          progressMessages(messagesA, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
        ).toContainEqual(
          expect.objectContaining({
            action: 'show',
            permission: expect.objectContaining({
              data: expect.objectContaining({
                approvalId: 'plan-before-close',
              }),
            }),
          }),
        );
      });

      owner.close();
      const pendingWhileClosed = bridgeInteractions(
        owner.bridgeA,
      ).requestPlanApproval?.({
        approvalId: 'plan-while-closed',
        streamId,
        plan: { objective: 'Buffer the approval until repair.' },
        goalEnabled: false,
      });
      expect(pendingWhileClosed).toBeDefined();

      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);
      try {
        const enableBypass = assertSupported(
          bridgeB.progressViewInboundHandlers[
            PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS
          ],
        );
        await enableBypass({
          command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
          stream: streamId,
        });
        expect(
          isApprovalBypassedForStream(streamId, owner.bridgeA.session),
        ).toBe(true);
        expect(
          isBashApprovalBypassedForStream(streamId, owner.bridgeA.session),
        ).toBe(true);
        expect(isApprovalBypassedForStream(streamId, bridgeB.session)).toBe(
          true,
        );

        await vi.waitFor(() => {
          const approvals = progressMessages(
            messagesB,
            PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          );
          for (const approvalId of ['plan-before-close', 'plan-while-closed']) {
            expect(approvals).toContainEqual(
              expect.objectContaining({
                action: 'show',
                permission: expect.objectContaining({
                  data: expect.objectContaining({ approvalId }),
                }),
              }),
            );
          }
        });

        for (const approvalId of ['plan-before-close', 'plan-while-closed']) {
          expect(
            bridgeB.hostInteractions.submitPlanDecision(approvalId, {
              action: 'approve',
            }),
          ).toBe(true);
        }
        await expect(pendingBeforeClose).resolves.toEqual({
          action: 'approve',
        });
        await expect(pendingWhileClosed).resolves.toEqual({
          action: 'approve',
        });
      } finally {
        bridgeB.dispose();
      }
    });

    it('releases process-session interactions when the stream is deleted', async () => {
      const streamId = 'rebound-stream-delete' as StreamTabId;
      const executionId = 'ec00f9' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        const planPromise = bridgeInteractions(
          owner.bridgeA,
        ).requestPlanApproval?.({
          approvalId: 'plan-rebound-delete',
          streamId,
          plan: { objective: 'Cancel through the durable owner.' },
          goalEnabled: false,
        });
        expect(planPromise).toBeDefined();
        await vi.waitFor(() => {
          expect(
            progressMessages(
              messagesB,
              PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
            ),
          ).toContainEqual(
            expect.objectContaining({
              action: 'show',
              permission: expect.objectContaining({
                data: expect.objectContaining({
                  approvalId: 'plan-rebound-delete',
                }),
              }),
            }),
          );
        });

        await bridgeB.deleteStream(streamId);

        await expect(planPromise).resolves.toEqual({
          action: 'reject',
          feedback: 'Stream resources released.',
        });
        expect(
          progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
        ).toContainEqual(
          expect.objectContaining({
            action: 'resolve',
            kind: PERMISSION_KIND.PLAN_APPROVAL,
            id: 'plan-rebound-delete',
          }),
        );
      } finally {
        bridgeB.dispose();
      }
    });

    it('makes one headless approval visible when reopening under an excluding filter', async () => {
      const streamId = 'rebound-filtered-approval' as StreamTabId;
      const owner = await createProcessOwner({
        streamId,
        executionId: 'ec00fa' as ExecutionId,
      });
      const filterStreams = assertSupported(
        owner.bridgeA.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.FILTER_STREAMS
        ],
      );
      await filterStreams({
        command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS,
        filter: 'toolUse',
      });
      owner.close();
      const pendingApproval =
        owner.processSession.interactions.requestPlanApproval({
          approvalId: 'plan-filtered-while-headless',
          streamId,
          plan: { objective: 'Restore the hidden approval stream.' },
          goalEnabled: false,
        });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        await vi.waitFor(() => {
          const approvalShows = progressMessages(
            messagesB,
            PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          ).filter(
            (message) =>
              message.action === 'show' &&
              message.permission?.data?.approvalId ===
                'plan-filtered-while-headless',
          );
          expect(approvalShows).toHaveLength(1);
          expect(
            progressMessages(
              messagesB,
              PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
            ).at(-1),
          ).toMatchObject({
            activeStream: streamId,
            agentFilter: 'all',
            streams: expect.arrayContaining([
              expect.objectContaining({ name: streamId }),
            ]),
          });
        });
        expect(
          bridgeB.hostInteractions.submitPlanDecision(
            'plan-filtered-while-headless',
            { action: 'approve' },
          ),
        ).toBe(true);
        await expect(pendingApproval).resolves.toEqual({ action: 'approve' });
      } finally {
        bridgeB.dispose();
      }
    });

    it('keeps children launched while headless canonical and stops their current handles (#8228)', async () => {
      const streamId = 'rebound-stream-4' as StreamTabId;
      const childStreamId = 'rebound-child-4' as StreamTabId;
      const executionId = 'ec00f0' as ExecutionId;
      const childExecutionId = 'ec00f1' as ExecutionId;
      const processExecutionId = 'ec00f2' as ExecutionId;
      const owner = await createProcessOwner({
        streamId,
        executionId,
      });
      const { ProcessExecutionHandle } = owner;
      const rootInterrupt = vi.fn();
      owner.handle.attachInterruptHandler({ interrupt: rootInterrupt });

      // Child handles have no canonical startup entry; only the owner knows them.
      const { handle: childHandle } = owner.createHandle({
        executionId: childExecutionId,
        childStreamId,
        agentName: 'searcher',
        category: AgentCategory.ToolUse,
      });
      const killProcess = vi.fn(() => true);
      const processHandle = new ProcessExecutionHandle(
        processExecutionId,
        streamId,
        'bash',
        killProcess,
        owner.noopAgentRuntimeHost,
      );
      const childInterrupt = vi.fn();
      childHandle.attachInterruptHandler({ interrupt: childInterrupt });
      owner.close();
      owner.processSession.executions.trackAgentExecution(childHandle, {
        status: STREAM_PHASE.RUNNING,
      });
      owner.processSession.executions.track(processHandle);
      expect(
        owner.processSession.executions.getActiveChildren(streamId),
      ).toMatchObject({
        subagents: [expect.objectContaining({ executionId: childExecutionId })],
        processes: [
          expect.objectContaining({ executionId: processExecutionId }),
        ],
      });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        bridgeB.syncFullView();
        // Both headless children and the child status remain in the one registry.
        expect(bridgeB.session.executions.getHandle(childExecutionId)).toBe(
          childHandle,
        );
        expect(bridgeB.session.executions.getHandle(processExecutionId)).toBe(
          processHandle,
        );
        expect(bridgeB.session.status.get(childStreamId)).toBe(
          STREAM_PHASE.RUNNING,
        );
        expect(
          progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
            -1,
          ),
        ).toMatchObject({
          streamStates: {
            [streamId]: {
              activeSubagents: [
                expect.objectContaining({ executionId: childExecutionId }),
              ],
              activeProcesses: [
                expect.objectContaining({ executionId: processExecutionId }),
              ],
            },
          },
        });

        // Native child follow-ups replace the owner-side handle and trace.
        const { handle: freshChildHandle } = owner.createHandle({
          executionId: childExecutionId,
          childStreamId,
          agentName: 'searcher',
          category: AgentCategory.ToolUse,
        });
        const freshChildInterrupt = vi.fn();
        freshChildHandle.attachInterruptHandler({
          interrupt: freshChildInterrupt,
        });
        owner.processSession.executions.track(freshChildHandle);
        expect(bridgeB.session.executions.getHandle(childExecutionId)).toBe(
          freshChildHandle,
        );

        // Stop cascades through root, current child turn, and process.
        const stopStream = assertSupported(
          bridgeB.progressViewInboundHandlers[
            PROGRESS_VIEW_COMMANDS.STOP_STREAM
          ],
        );
        await stopStream({
          command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
          stream: streamId,
        });
        expect(rootInterrupt).toHaveBeenCalledTimes(1);
        expect(childInterrupt).not.toHaveBeenCalled();
        expect(freshChildInterrupt).toHaveBeenCalledTimes(1);
        expect(killProcess).toHaveBeenCalledTimes(1);

        owner.processSession.executions.untrack(processExecutionId);
        expect(
          bridgeB.session.executions.getHandle(processExecutionId),
        ).toBeUndefined();

        // Identity-safe removal clears the canonical registry.
        freshChildHandle.settleResult({
          type: 'result',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId: childExecutionId,
          streamId: childStreamId,
          agentName: 'searcher',
          category: 'toolUse',
          isSubagent: true,
        } as unknown as Parameters<typeof freshChildHandle.settleResult>[0]);
        owner.processSession.executions.untrack(childExecutionId);
        await freshChildHandle.result;
        await settleProgressEvents();
        expect(
          bridgeB.session.executions.getHandle(childExecutionId),
        ).toBeUndefined();
        expect(
          owner.bridgeA.session.executions.getHandle(childExecutionId),
        ).toBeUndefined();
      } finally {
        bridgeB.dispose();
      }
    });

    it('completes a coordinated auto-close deletion while headless before reopen', async () => {
      const streamId = 'headless-remove-parent' as StreamTabId;
      const childStreamId = 'bash#headless-remove-child' as StreamTabId;
      const owner = await createProcessOwner({
        streamId,
        executionId: 'ec00f7' as ExecutionId,
      });
      owner.processSession.transcripts.ensureStream(childStreamId);
      owner.progressSnapshotStore.setDescription(
        childStreamId,
        'Transient bash child',
      );
      seedStreamStatusForTest(
        owner.processSession.status,
        childStreamId,
        STREAM_PHASE.RUNNING,
      );
      owner.processSession.followUps.enqueue(
        childStreamId,
        { text: 'late follow-up' },
        { force: true },
      );
      await owner.processSession.flushArtifacts();
      owner.close();
      const pendingApproval =
        owner.processSession.interactions.requestPlanApproval({
          approvalId: 'headless-remove-approval',
          streamId: childStreamId,
          plan: { objective: 'This must be released.' },
          goalEnabled: false,
        });

      owner.processSession.events.emit({
        scope: 'session',
        event: {
          type: 'removeStream',
          payload: { streamId: childStreamId },
        },
      });
      await owner.sessionStores.waitForPendingStreamDeletions();
      expect(owner.processSession.transcripts.has(childStreamId)).toBe(false);
      expect(owner.processSession.status.get(childStreamId)).toBeUndefined();
      expect(owner.processSession.followUps.getAll(childStreamId)).toEqual([]);
      await expect(pendingApproval).resolves.toEqual({
        action: 'reject',
        feedback: 'Stream resources released.',
      });
      expect(
        await owner.progressSnapshotStore.listPersistedStreams(),
      ).not.toContain(childStreamId);

      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);
      try {
        bridgeB.syncFullView();
        expect(
          progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
            -1,
          ),
        ).toMatchObject({
          streams: [expect.objectContaining({ name: streamId })],
        });
        expect(
          (
            progressMessages(
              messagesB,
              PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
            ).at(-1) as ProgressMessage
          ).streams?.map((stream) => stream.name),
        ).not.toContain(childStreamId);
      } finally {
        bridgeB.dispose();
      }
    });

    it('reattaches while an overlapping headless deletion settles as failed', async () => {
      const streamId = 'headless-remove-owner' as StreamTabId;
      const failedStreamId = 'headless-remove-failure' as StreamTabId;
      const owner = await createProcessOwner({
        streamId,
        executionId: 'ec00f6' as ExecutionId,
      });
      owner.processSession.transcripts.ensureStream(failedStreamId);
      const failure = new Error('execution metadata unavailable');
      let markDeletionStarted!: () => void;
      const deletionStarted = new Promise<void>((resolve) => {
        markDeletionStarted = resolve;
      });
      let releaseDeletion!: () => void;
      const deletionGate = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      vi.spyOn(
        owner.progressSnapshotStore,
        'readPersistedExecutionId',
      ).mockImplementationOnce(async () => {
        markDeletionStarted();
        await deletionGate;
        throw failure;
      });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      owner.close();

      try {
        owner.processSession.events.emit({
          scope: 'session',
          event: {
            type: 'removeStream',
            payload: { streamId: failedStreamId },
          },
        });
        await deletionStarted;
        const pendingDrain = vi.spyOn(
          owner.sessionStores,
          'waitForPendingStreamDeletions',
        );
        const reopening = owner.reopen();
        await vi.waitFor(() => expect(pendingDrain).toHaveBeenCalled());
        releaseDeletion();

        const { bridgeB } = await reopening;
        bridgeB.syncFullView();
        await settleProgressEvents();
        expect(unhandled).not.toHaveBeenCalled();
        expect(owner.processSession.transcripts.has(failedStreamId)).toBe(true);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('preserves live phase, handle replacement, trace, and result across reopen (#8230, #8231)', async () => {
      const streamId = 'rebound-stream-5' as StreamTabId;
      const executionId = 'ec00f3' as ExecutionId;
      const owner = await createProcessOwner({
        streamId,
        executionId,
      });
      const { bridgeB, errorsB } = await owner.reopen();
      const resultsSeenByB: unknown[] = [];
      const detachResult = bridgeB.session.onResult((event) => {
        resultsSeenByB.push(event);
      });

      try {
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          owner.handle,
        );
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);

        // Window presentation does not split canonical lifecycle state.
        expect(
          owner.bridgeA.session.status.transitionToWaiting(streamId, 'wait', {
            trace: owner.trace as unknown as AgentTrace,
          }),
        ).toBe(true);
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
        expect(
          owner.bridgeA.session.status.transition(
            streamId,
            STREAM_PHASE.RUNNING,
            'resume',
            { trace: owner.trace as unknown as AgentTrace },
          ),
        ).toBe(true);
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);

        // A later turn replaces both handle and trace in the same registry.
        const { handle: freshHandle, trace: freshTrace } = owner.createHandle();
        owner.bridgeA.session.executions.track(freshHandle);
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
        expect(
          owner.bridgeA.session.status.transitionToWaiting(streamId, 'wait', {
            trace: freshTrace as unknown as AgentTrace,
          }),
        ).toBe(true);
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);

        const resultEvent = {
          type: 'result' as const,
          outcome: RUN_OUTCOME.FAILED,
          executionId,
          streamId,
          agentName: 'proofreader',
          category: 'workflow' as const,
          isSubagent: false,
          error: {
            kind: 'unexpected' as const,
            message: 'Failure after desktop reopen.',
          },
        };
        freshTrace.emit(resultEvent);
        expect(
          owner.processSession.status.transitionToTerminal(
            streamId,
            STREAM_PHASE.FAILED,
            { trace: freshTrace as unknown as AgentTrace },
          ),
        ).toBe(true);
        expect(resultsSeenByB).toContainEqual(resultEvent);
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.FAILED);
        expect(errorsB).toEqual(['Failure after desktop reopen.']);
        expect(owner.errorsA).toEqual([]);
        owner.bridgeA.session.executions.untrack(executionId);
        expect(
          bridgeB.session.executions.getHandle(executionId),
        ).toBeUndefined();
      } finally {
        detachResult();
        bridgeB.dispose();
      }
    });

    it('detaches a closed presentation without disposing process executions', async () => {
      const streamId = 'rebound-stream-dispose' as StreamTabId;
      const executionId = 'ec00f5' as ExecutionId;
      const processExecutionId = 'ec00f6' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();

      const processHandle = new owner.ProcessExecutionHandle(
        processExecutionId,
        streamId,
        'bash',
        () => true,
        owner.noopAgentRuntimeHost,
      );
      owner.bridgeA.session.executions.track(processHandle);
      expect(bridgeB.session.executions.getHandle(processExecutionId)).toBe(
        processHandle,
      );

      bridgeB.dispose();
      expect(owner.processSession.executions.getHandle(executionId)).toBe(
        owner.handle,
      );
      expect(
        owner.processSession.executions.getHandle(processExecutionId),
      ).toBe(processHandle);

      const { handle: freshHandle } = owner.createHandle();
      owner.processSession.executions.track(freshHandle);
      const { bridgeB: bridgeC } = await owner.reopen();
      try {
        expect(bridgeC.session).toBe(owner.processSession);
        expect(bridgeC.session.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
        expect(bridgeC.session.executions.getHandle(processExecutionId)).toBe(
          processHandle,
        );
      } finally {
        bridgeC.dispose();
        owner.processSession.executions.untrack(processExecutionId);
        owner.processSession.executions.untrack(executionId);
      }
    });

    it('keeps a replacement handle when its stale predecessor settles late (#8229)', async () => {
      const streamId = 'rebound-stream-6' as StreamTabId;
      const executionId = 'ec00f4' as ExecutionId;
      const owner = await createProcessOwner({
        streamId,
        executionId,
        agentName: 'search',
        category: AgentCategory.ToolUse,
      });
      owner.close();
      // Suspend while headless before reopening.
      expect(
        owner.bridgeA.session.status.transitionToWaiting(streamId, 'wait', {
          trace: owner.trace as unknown as AgentTrace,
        }),
      ).toBe(true);
      const { bridgeB } = await owner.reopen();

      try {
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          owner.handle,
        );

        // Resume replaces the canonical handle under the same id.
        const { handle: freshHandle } = owner.createHandle();
        bridgeB.session.executions.track(freshHandle);
        expect(
          bridgeB.session.status.transition(
            streamId,
            STREAM_PHASE.RUNNING,
            'resume',
          ),
        ).toBe(true);

        expect(owner.bridgeA.session.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
        // Identity-safe cleanup preserves the fresh handle.
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          freshHandle,
        );

        // Even a late settle of the stale handle cannot clobber the fresh one.
        owner.handle.settleResult({
          type: 'result',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId,
          streamId,
          agentName: 'search',
          category: 'toolUse',
          isSubagent: false,
        } as unknown as Parameters<typeof owner.handle.settleResult>[0]);
        await owner.handle.result;
        await settleProgressEvents();
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
      } finally {
        bridgeB.dispose();
      }
    });

    it('publishes canonical status changes as updateStreamStatus session facts (#8256)', async () => {
      const streamId = 'rebound-stream-7' as StreamTabId;
      const executionId = 'ec00f7' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();
      const facts: SessionFact[] = [];
      const detachFacts = bridgeB.session.events.subscribe(
        (event) => {
          if (event.scope === 'session') facts.push(event.event);
        },
        { scope: 'session' },
      );

      try {
        // A bare process-session transition (no live trace) still reaches the
        // reopened presentation as a session fact.
        expect(
          owner.processSession.status.transitionToWaiting(streamId, 'wait', {
            events: owner.processSession.events,
          }),
        ).toBe(true);
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
        expect(facts).toContainEqual(
          expect.objectContaining({
            type: 'updateStreamStatus',
            payload: expect.objectContaining({
              streamId,
              status: STREAM_PHASE.WAITING,
            }),
          }),
        );
      } finally {
        detachFacts();
        bridgeB.dispose();
      }
    });

    it('preserves a child terminal status that lands after owner untrack (#8257)', async () => {
      const streamId = 'rebound-stream-8' as StreamTabId;
      const childStreamId = 'rebound-child-8' as StreamTabId;
      const executionId = 'ec00f8' as ExecutionId;
      const childExecutionId = 'ec00f9' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { handle: childHandle } = owner.createHandle({
        executionId: childExecutionId,
        childStreamId,
        agentName: 'searcher',
        category: AgentCategory.ToolUse,
      });
      const { bridgeB } = await owner.reopen();
      const facts: SessionFact[] = [];
      const detachFacts = bridgeB.session.events.subscribe(
        (event) => {
          if (event.scope === 'session') facts.push(event.event);
        },
        { scope: 'session' },
      );

      try {
        owner.bridgeA.session.executions.trackAgentExecution(childHandle, {
          status: STREAM_PHASE.RUNNING,
        });
        expect(bridgeB.session.status.get(childStreamId)).toBe(
          STREAM_PHASE.RUNNING,
        );

        // Child finalization order (finalizeChildStream): untrack first,
        // terminal stream status second, and no `result` trace event at all.
        owner.bridgeA.session.executions.untrack(childExecutionId);
        expect(
          bridgeB.session.executions.getHandle(childExecutionId),
        ).toBeUndefined();
        expect(
          owner.bridgeA.session.status.transitionToTerminal(
            childStreamId,
            STREAM_PHASE.COMPLETED,
            { events: owner.processSession.events },
          ),
        ).toBe(true);
        expect(bridgeB.session.status.get(childStreamId)).toBe(
          STREAM_PHASE.COMPLETED,
        );
        expect(facts).toContainEqual(
          expect.objectContaining({
            type: 'updateStreamStatus',
            payload: expect.objectContaining({
              streamId: childStreamId,
              status: STREAM_PHASE.COMPLETED,
            }),
          }),
        );
      } finally {
        detachFacts();
        bridgeB.dispose();
      }
    });

    it('moves a waiting canonical stream to terminal after owner untrack', async () => {
      const streamId = 'rebound-stream-12' as StreamTabId;
      const executionId = 'ec00fe' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();

      try {
        // Finalization untracks first, then performs WAITING -> terminal.
        expect(
          bridgeB.session.status.transitionToWaiting(streamId, 'wait'),
        ).toBe(true);
        owner.bridgeA.session.executions.untrack(executionId);
        expect(
          owner.bridgeA.session.status.transitionToTerminal(
            streamId,
            STREAM_PHASE.COMPLETED,
          ),
        ).toBe(true);
        expect(bridgeB.session.status.get(streamId)).toBe(
          STREAM_PHASE.COMPLETED,
        );
      } finally {
        bridgeB.dispose();
      }
    });

    it('persists exact headless run facts and restores them once on reopen (#8258)', async () => {
      const streamId = 'rebound-stream-9' as StreamTabId;
      const childStreamId = 'rebound-child-9' as StreamTabId;
      const executionId = 'ec00fa' as ExecutionId;
      const childExecutionId = 'ec00fb' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const childConfig = {
        agent: 'searcher',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        toolConfig: DEFAULT_TOOL_CONFIG,
      } as unknown as AgentConfig;
      const outputFile: OutputFileInfo = {
        source: 'exact-output.tex',
        location: {
          kind: 'workspace',
          absolutePath: '/workspace/exact-output.pdf',
          relativePath: 'exact-output.pdf',
        },
        round: 1,
        lineage: null,
        diff: null,
      };
      const events: SessionEvent[] = [];
      const detachEvents = owner.processSession.events.subscribe((event) => {
        events.push(event);
      });

      owner.close();
      let bridgeB: TestableBridge | undefined;
      try {
        owner.processSession.transcripts.ensureStream(childStreamId);
        await owner
          .getExecutionStore(childExecutionId)
          .writeConfig(childConfig);
        const { handle: childHandle } = owner.createHandle({
          executionId: childExecutionId,
          childStreamId,
          agentName: 'searcher',
          category: AgentCategory.ToolUse,
        });
        owner.processSession.publishRunEvent(childStreamId, {
          type: 'run.config',
          streamId: childStreamId,
          executionId: childExecutionId,
          config: childConfig,
        });
        owner.processSession.events.emit({
          scope: 'session',
          event: {
            type: 'updateStreamDescription',
            payload: {
              streamId: childStreamId,
              description: 'Search the docs',
            },
          },
        });
        owner.processSession.events.emit({
          scope: 'session',
          event: {
            type: 'setParentStream',
            payload: {
              childStreamId,
              parentStreamId: streamId,
            },
          },
        });
        owner.processSession.publishRunEvent(childStreamId, {
          type: 'usage',
          payload: {
            streamId: childStreamId,
            storageKey: childExecutionId as StorageKey,
            usage: {
              inputTokens: 11,
              outputTokens: 7,
              cost: 0.125,
            },
          },
        } as AgentEvent);
        owner.processSession.publishRunEvent(childStreamId, {
          type: 'addOutputFiles',
          streamId: childStreamId,
          filesByRound: { 1: [outputFile] },
        });
        owner.processSession.executions.trackAgentExecution(childHandle, {
          status: STREAM_PHASE.RUNNING,
        });
        owner.processSession.transcripts.append(childStreamId, {
          id: 'headless-log',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 2_000,
          text: 'Emitted while the desktop had no window.',
        });

        expect(events).toContainEqual(
          expect.objectContaining({
            scope: 'run',
            streamId: childStreamId,
            event: expect.objectContaining({
              type: 'run.config',
              executionId: childExecutionId,
              config: childConfig,
            }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            scope: 'session',
            event: expect.objectContaining({
              type: 'updateStreamDescription',
              payload: {
                streamId: childStreamId,
                description: 'Search the docs',
              },
            }),
          }),
        );
        await settleProgressEvents();
        await owner.processSession.flushArtifacts();
        const messagesB: unknown[] = [];
        const reopened = await owner.reopen(messagesB);
        bridgeB = reopened.bridgeB;
        const { progressSnapshotStore } = reopened;
        // Output files are not part of a tool-use stream's full-render payload;
        // verify that durable fact separately while the common facts below are
        // checked at the renderer boundary.
        expect(progressSnapshotStore.getOutputFiles(childStreamId)).toEqual({
          1: [outputFile],
        });

        bridgeB.setActiveStream(childStreamId);
        const childMessages = (command: string, idKey: string) =>
          progressMessages(messagesB, command).filter(
            (message) =>
              (message as unknown as Record<string, unknown>)[idKey] ===
              childStreamId,
          );
        await vi.waitFor(() => {
          expect(
            childMessages(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT, 'stream'),
          ).toHaveLength(1);
          expect(
            childMessages(PROGRESS_VIEW_COMMANDS.LOG_DELTA, 'streamId'),
          ).toHaveLength(1);
        });
        expect(
          progressMessages(messagesB, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
            -1,
          ),
        ).toMatchObject({
          activeStream: childStreamId,
          streams: expect.arrayContaining([
            expect.objectContaining({
              name: childStreamId,
              agent: 'searcher',
              agentCategory: AgentCategory.ToolUse,
              parentStreamId: streamId,
              description: 'Search the docs',
            }),
          ]),
        });
        expect(
          childMessages(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT, 'stream'),
        ).toEqual([
          expect.objectContaining({
            action: 'render',
            kind: AgentCategory.ToolUse,
            runUsage: {
              [childExecutionId]: expect.objectContaining({
                inputTokens: 11,
                outputTokens: 7,
                cost: 0.125,
              }),
            },
            activeState: expect.objectContaining({
              parentStreamId: streamId,
            }),
          }),
        ]);
        expect(
          childMessages(PROGRESS_VIEW_COMMANDS.LOG_DELTA, 'streamId'),
        ).toEqual([
          expect.objectContaining({
            entries: [
              expect.objectContaining({
                id: 'headless-log',
                text: 'Emitted while the desktop had no window.',
              }),
            ],
          }),
        ]);
      } finally {
        bridgeB?.dispose();
        detachEvents();
        await owner.getExecutionStore(childExecutionId).clear();
      }
    });
  });
});
