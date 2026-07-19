// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - transcript
import {
  STREAM_LOGS_DIR,
  type StreamLogStore,
  type StreamSnapshotStore as ProgressSnapshotStore,
} from '@transcript';

// Local imports - agent state
import { seedStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { noopTrace, type AgentEvent, type AgentTrace } from '@agent/trace';
import {
  AgentConfigSchema,
  WorkflowAgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  TaskStateSchema,
  type WorkflowTaskState,
} from '@agent/core/state/TaskState';
import type { PlanApprovalResult } from '@agent/runtime/HostInteractions';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { SessionEvent, SessionFact } from '@agent/runtime/SessionEventHub';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - desktop and progress schemas
import { DESKTOP_SHELL_COMMANDS } from '@desktop/desktopShellMessages';
import {
  AgentCategory,
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { assertSupported } from '@shared/utils/dispatcher';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
} from '@tools/approval';

// Local imports - desktop test support
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
  flush(): Promise<void>;
  dispose(): void;
};

type TestableBridge = Bridge & {
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
  deferReady?: boolean;
  afterCanonicalLoad?: () => Promise<void>;
  detectWaitingStreams?: ReturnType<typeof vi.fn>;
  repairRestartedStreams?: ReturnType<typeof vi.fn>;
  activeExecutionIds?: readonly string[] | (() => readonly string[]);
  showErrorMessage?: (message: string) => Promise<void> | void;
  openPath?: (filePath: string, line?: number) => Promise<void>;
  /** Captures `this.logger.error(...)` calls made by the bridge under test. */
  loggerErrorSpy?: ReturnType<typeof vi.fn<AgentTrace['error']>>;
};

type ProgressMessage = {
  command?: string;
  action?: string;
  kind?: string;
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
  streamState?: unknown;
  runUsage?: Record<string, unknown>;
  outputs?: {
    files: Record<string, unknown>;
    missing: Record<string, unknown>;
    compileFailures: Record<string, unknown>;
  };
  activeState?: unknown;
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
  createProgressSnapshotStore(): ProgressSnapshotStore;
  progressSnapshotStore: ProgressSnapshotStore;
}> {
  vi.resetModules();
  const kvStoreBacking = options.kvStoreBacking ?? new Map<string, unknown>();
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform());
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
  const { initializeDefaultSession } =
    await import('@agent/runtime/SessionHandle');
  initializeDefaultSession({
    transcripts: StreamLogStore.ephemeral('desktop module test default'),
  });
  return {
    bridgeModule,
    createProgressSnapshotStore,
    openTranscripts: () => StreamLogStore.open(),
    progressSnapshotStore,
  };
}

async function createBridge(
  messages: unknown[],
  options: CreateBridgeOptions = {},
): Promise<TestableBridge> {
  const { bridgeModule, openTranscripts, progressSnapshotStore } =
    await loadBridgeModule(options);
  const transcripts = await openTranscripts();
  for (const streamId of options.canonicalStreamIds ?? []) {
    transcripts.ensureStream(streamId);
  }
  await options.configureTranscripts?.(transcripts);
  await transcripts.flush();
  if (options.configureProgressSnapshotStore) {
    await progressSnapshotStore.load(transcripts.keys());
    await options.configureProgressSnapshotStore(progressSnapshotStore);
    await progressSnapshotStore.flush();
  }
  const bridge = disposeAfterTest(
    new bridgeModule.DesktopProgressBridge(
      (message) => {
        messages.push(message);
      },
      {
        transcripts,
        logger: options.loggerErrorSpy
          ? { ...noopTrace, error: options.loggerErrorSpy }
          : undefined,
        progressSnapshotStore,
        afterCanonicalLoad: options.afterCanonicalLoad,
        host: createStubDesktopAgentExecutionHost({
          ...(options.showErrorMessage
            ? { showErrorMessage: options.showErrorMessage }
            : {}),
          ...(options.openPath ? { openPath: options.openPath } : {}),
        }),
      },
    ) as unknown as TestableBridge,
  );
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

  it('routes session facts to the window-local desktop backend', async () => {
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
      emitRunConfigFact(bridge, {
        streamId: 'stream-new',
        executionId: 'abc123',
        taskState,
      });

      const runNew = assertSupported(
        bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW],
      );
      expect(runNew).toBeTypeOf('function');
      const runPromise = runNew({
        command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
        stream: 'stream-new',
      });

      await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
      await settleProgressEvents();
      expect(runAgent).not.toHaveBeenCalled();

      finishRepair(new Set());
      await runPromise;
      await bridge.waitUntilReady();

      expect(runAgent).toHaveBeenCalledOnce();
    } finally {
      finishRepair(new Set());
    }
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

    await createBridge([], {
      canonicalStreamIds: [streamId],
      configureProgressSnapshotStore: (store) => {
        snapshots = store;
        store.setTaskState(
          streamId,
          TaskStateSchema.parse(workflowTaskState()),
          executionId,
        );
      },
      afterCanonicalLoad: async () => {
        expect(snapshots?.getExecutionId(streamId)).toBe(executionId);
        expect(detectWaitingStreams).not.toHaveBeenCalled();
      },
      detectWaitingStreams,
    });

    expect(detectWaitingStreams).toHaveBeenCalledWith(
      new Map([[streamId, executionId]]),
    );
  });

  it('rechecks active executions after waiting detection before repairing logs', async () => {
    const streamId = 'race-stream' as StreamTabId;
    const executionId = 'abc123' as ExecutionId;
    let activeExecutionIds: readonly string[] = [];
    let finishDetection!: (value: Set<StreamTabId>) => void;
    const detectionGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => detectionGate);
    const bridge = await createBridge([], {
      activeExecutionIds: () => activeExecutionIds,
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
      activeExecutionIds = [executionId];
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
    const bridge = await createBridge([], { retrieveSessionResumeData });

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
    const bridge = await createBridge([], { retrieveSessionResumeData });

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

    await bridge.flush();
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

  // Stage-5 acceptance gate (#6968): two desktop windows, runs in each, zero
  // cross-talk in view state, transcripts, and status. Each window is a
  // `DesktopProgressBridge` with its own per-window `SessionHandle`, built
  // from ONE module registry — the same process globals a real multi-window
  // desktop main process shares — so any leak through a surviving singleton
  // would surface here. Pins the L1–L3 leak fixes from
  // docs/proposals/session-scoped-runtime-architecture.md §1.
  describe('multi-window session isolation', () => {
    const streamA = 'stream-window-a' as StreamTabId;
    const streamB = 'stream-window-b' as StreamTabId;
    const executionA = 'ec00aa';
    const executionB = 'ec00bb';

    type WindowFixture = {
      bridge: TestableBridge;
      session: SessionHandle;
      /** Loosely-typed runtime-host emit, as runs use it (`runtimeHost.emit`). */
      emit: (event: string, payload: unknown) => void;
      messages: unknown[];
    };

    type WindowPair = {
      windowA: WindowFixture;
      windowB: WindowFixture;
      /**
       * Same-registry `defaultSession` (the one the bridges actually use) —
       * there is no separate `StreamStatusService`/`getDefaultStreamLogStore`
       * module export anymore (#7694): the process-wide default session owns
       * its `status`/`transcripts` members directly.
       */
      registry: {
        defaultSession: typeof import('@agent/runtime/SessionHandle').defaultSession;
      };
      dispose(): void;
    };

    async function createWindowPair(): Promise<WindowPair> {
      const { bridgeModule, createProgressSnapshotStore, openTranscripts } =
        await loadBridgeModule();
      // Same registry as the bridge module graph — identity comparisons
      // against process-wide defaults must use this instance, not a
      // statically imported copy from the pre-reset registry.
      const { defaultSession } = await import('@agent/runtime/SessionHandle');
      const makeWindow = async (): Promise<WindowFixture> => {
        const messages: unknown[] = [];
        const transcripts = await openTranscripts();
        const bridge = new bridgeModule.DesktopProgressBridge(
          (message) => {
            messages.push(message);
          },
          {
            transcripts,
            progressSnapshotStore: createProgressSnapshotStore(),
            host: createStubDesktopAgentExecutionHost(),
          },
        ) as unknown as TestableBridge;
        const session = (bridge as unknown as { session: SessionHandle })
          .session;
        return {
          bridge,
          session,
          emit: (event, payload) => bridge.runtimeHost.emit(event, payload),
          messages,
        };
      };
      const [windowA, windowB] = await Promise.all([
        makeWindow(),
        makeWindow(),
      ]);
      await Promise.all([
        windowA.bridge.waitUntilReady(),
        windowB.bridge.waitUntilReady(),
      ]);
      windowA.messages.length = 0;
      windowB.messages.length = 0;
      return disposeAfterTest({
        windowA,
        windowB,
        registry: {
          defaultSession,
        },
        dispose: () => {
          windowA.bridge.dispose();
          windowB.bridge.dispose();
        },
      });
    }

    function messagesMentioning(
      messages: unknown[],
      needle: string,
    ): unknown[] {
      return messages.filter((message) => {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(message);
        } catch {
          return false;
        }
        return serialized?.includes(needle) ?? false;
      });
    }

    /** Bridge a fake run trace into a session, as `runAgent` does. */
    function attachTrace(
      session: SessionHandle,
      streamId: StreamTabId,
      trace: ReturnType<typeof makeFakeTrace>,
    ): void {
      session.attachRunTrace(
        trace as unknown as Parameters<SessionHandle['attachRunTrace']>[0],
        streamId,
      );
    }

    it('keeps one window’s rail, entries, and status updates out of the sibling view state', async () => {
      const pair = await createWindowPair();
      const { windowA, windowB } = pair;

      // Simulated run lifecycle in each window over its own runtime host:
      // track → status transitions → log entry → terminal.
      for (const [window, streamId, executionId] of [
        [windowA, streamA, executionA],
        [windowB, streamB, executionB],
      ] as const) {
        window.emit('setActiveStream', {
          streamId,
          agentCategory: AgentCategory.Workflow,
        });
        window.emit('setTaskState', {
          streamId,
          executionId,
          taskState: TaskStateSchema.parse(workflowTaskState()),
        });
        window.emit('updateStreamStatus', {
          streamId,
          status: STREAM_PHASE.RUNNING,
        });
        window.bridge.streamLogs.append(streamId, {
          id: `${streamId}-log`,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 1_000,
          text: `${streamId} run log`,
        });
        window.emit('updateStreamStatus', {
          streamId,
          status: STREAM_PHASE.COMPLETED,
          previousStatus: STREAM_PHASE.RUNNING,
        });
      }
      await settleProgressEvents();
      windowA.bridge.syncFullView();
      windowB.bridge.syncFullView();
      await settleProgressEvents();

      // Each window's own run is fully visible to itself...
      expect(windowA.bridge.streamLogs.get(streamA)).toBeDefined();
      expect(
        progressMessages(
          windowA.messages,
          PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        ).at(-1),
      ).toMatchObject({ activeStream: streamA });
      expect(windowB.bridge.streamLogs.get(streamB)).toBeDefined();

      // ...and completely invisible to the sibling: no view-state entry or
      // renderer message (stream list, status, or log delta) at all.
      expect(windowB.bridge.streamLogs.get(streamA)).toBeUndefined();
      expect(windowA.bridge.streamLogs.get(streamB)).toBeUndefined();
      expect(messagesMentioning(windowB.messages, streamA)).toEqual([]);
      expect(messagesMentioning(windowA.messages, streamB)).toEqual([]);
    });

    it('delivers run facts and session facts only to the owning session’s hub subscribers', async () => {
      const pair = await createWindowPair();
      const { windowA, windowB } = pair;

      const factKey = (event: SessionEvent): string =>
        event.scope === 'run'
          ? `run:${event.streamId}:${event.event.type}`
          : `session:${event.event.type}:${
              (event.event.payload as { streamId?: string }).streamId ?? ''
            }`;
      const seenByA: string[] = [];
      const seenByB: string[] = [];
      windowA.session.events.subscribe((event) => seenByA.push(factKey(event)));
      windowB.session.events.subscribe((event) => seenByB.push(factKey(event)));
      // Even a subscriber that explicitly asks B's hub for A's stream must
      // see nothing — the hub itself never carries the foreign stream.
      const crossStreamFacts: SessionEvent[] = [];
      windowB.session.events.subscribe(
        (event) => crossStreamFacts.push(event),
        { scope: 'run', streamId: streamA },
      );
      const resultsSeenByB: unknown[] = [];
      windowB.session.onResult((event) => resultsSeenByB.push(event));

      // A run in each window: trace bridged into the launching session
      // (as runAgent does), distinct streamIds and executionIds.
      for (const [window, streamId, executionId] of [
        [windowA, streamA, executionA],
        [windowB, streamB, executionB],
      ] as const) {
        const trace = makeFakeTrace();
        attachTrace(window.session, streamId, trace);
        trace.emit({
          type: 'log',
          level: 'info',
          message: `${streamId} progress`,
        });
        window.session.events.emit({
          scope: 'session',
          event: {
            type: 'updateStreamDescription',
            payload: {
              streamId,
              description: `${streamId} description`,
            },
          },
        });
        trace.emit({
          type: 'result',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
          agentName: 'proofreader',
          category: 'workflow',
          isSubagent: false,
        });
      }

      expect(seenByA).toEqual([
        `run:${streamA}:log`,
        `session:updateStreamDescription:${streamA}`,
        `run:${streamA}:result`,
      ]);
      expect(seenByB).toEqual([
        `run:${streamB}:log`,
        `session:updateStreamDescription:${streamB}`,
        `run:${streamB}:result`,
      ]);
      // Fully disjoint streams: no fact key is seen by both hubs.
      expect(seenByA.filter((key) => seenByB.includes(key))).toEqual([]);
      expect(crossStreamFacts).toEqual([]);
      expect(resultsSeenByB).toEqual([
        expect.objectContaining({ executionId: executionB }),
      ]);
    });

    it('keeps a pending approval invisible and unresolvable from the sibling window', async () => {
      const pair = await createWindowPair();
      const { windowA, windowB } = pair;

      const approvalId = 'plan-window-a';
      const result = bridgeInteractions(windowA.bridge).requestPlanApproval?.({
        approvalId,
        streamId: streamA,
        plan: { objective: 'Prove per-window interaction isolation.' },
        goalEnabled: false,
      });
      expect(result).toBeDefined();
      let settled = false;
      void (result as Promise<unknown>).then(() => {
        settled = true;
      });

      await vi.waitFor(() => {
        expect(
          progressMessages(
            windowA.messages,
            PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          ),
        ).toContainEqual(expect.objectContaining({ action: 'show' }));
      });
      // The prompt never reaches window B's renderer.
      expect(
        progressMessages(
          windowB.messages,
          PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
        ),
      ).toEqual([]);

      // B's response port cannot settle A's pending approval...
      expect(
        windowB.bridge.hostInteractions.submitPlanDecision(approvalId, {
          action: 'approve',
        }),
      ).toBe(false);
      // ...neither can B's inbound plan-approval handler...
      const handlePlanB = assertSupported(
        windowB.bridge.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION
        ],
      );
      await handlePlanB({
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        approvalId,
        action: 'approve',
      });
      // ...nor B's delete-all sweep (the cross-window sweep the Stage-5
      // gate exists to rule out).
      await windowB.bridge.deleteAllStreams();
      await settleProgressEvents();
      expect(settled).toBe(false);

      // A's own surface still resolves it, first try.
      const handlePlanA = assertSupported(
        windowA.bridge.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION
        ],
      );
      await handlePlanA({
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        approvalId,
        action: 'approve',
      });
      await expect(result).resolves.toEqual({ action: 'approve' });
    });

    it('scopes transcript stores to the launching session (L1)', async () => {
      const pair = await createWindowPair();
      const { windowA, windowB, registry } = pair;

      // The L1 fix, by identity: each window owns a fresh transcript store,
      // and neither aliases the process-default (last-writer-wins) store.
      expect(windowA.session.transcripts).not.toBe(windowB.session.transcripts);
      expect(windowA.session.transcripts).not.toBe(
        registry.defaultSession().transcripts,
      );
      expect(windowB.session.transcripts).not.toBe(
        registry.defaultSession().transcripts,
      );

      for (const [window, streamId] of [
        [windowA, streamA],
        [windowB, streamB],
      ] as const) {
        window.session.transcripts.append(streamId, {
          id: `${streamId}-transcript`,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 1_000,
          text: `${streamId} transcript entry`,
        });
      }

      expect(windowA.session.transcripts.has(streamA)).toBe(true);
      expect(windowB.session.transcripts.has(streamB)).toBe(true);
      // A's transcript writes never land under B's stores, and vice versa —
      // neither the session transcript store nor the view-state log store.
      expect(windowB.session.transcripts.has(streamA)).toBe(false);
      expect(windowA.session.transcripts.has(streamB)).toBe(false);
      expect(windowB.bridge.streamLogs.get(streamA)).toBeUndefined();
      expect(windowA.bridge.streamLogs.get(streamB)).toBeUndefined();
      expect(registry.defaultSession().transcripts.has(streamA)).toBe(false);
      expect(registry.defaultSession().transcripts.has(streamB)).toBe(false);
    });

    it('keeps stream phases, listeners, and sweeps per-window in the status machine (L3)', async () => {
      const pair = await createWindowPair();
      const { windowA, windowB, registry } = pair;

      // Desktop windows own fresh status machines. The process-wide
      // default session's status machine survives, but only as the
      // single-session default-session compatibility path (extension/CLI) —
      // a ledgered residue tracked on #6981 (D1 rows), not a desktop
      // multi-window sharing point. Assert the isolation that IS promised:
      // neither window aliases it, and neither window writes to it.
      expect(windowA.session.status).not.toBe(windowB.session.status);
      expect(windowA.session.status).not.toBe(registry.defaultSession().status);
      expect(windowB.session.status).not.toBe(registry.defaultSession().status);

      const changesSeenByB: unknown[] = [];
      windowB.session.status.onDidChange((change) =>
        changesSeenByB.push(change),
      );

      expect(
        windowA.session.status.transition(
          streamA,
          STREAM_PHASE.RUNNING,
          STREAM_TRANSITION_CAUSE.LIFECYCLE,
        ),
      ).toBe(true);
      expect(
        windowB.session.status.transition(
          streamB,
          STREAM_PHASE.RUNNING,
          STREAM_TRANSITION_CAUSE.LIFECYCLE,
        ),
      ).toBe(true);
      expect(
        windowA.session.status.transitionToTerminal(
          streamA,
          STREAM_PHASE.COMPLETED,
        ),
      ).toBe(true);

      // A's phases never appear in B's machine, and A's transitions never
      // fire B's listeners (the L3 waiter fan-out half).
      expect(windowB.session.status.get(streamA)).toBeUndefined();
      expect(windowA.session.status.get(streamB)).toBeUndefined();
      expect(
        changesSeenByB.filter(
          (change) => (change as { streamId: string }).streamId === streamA,
        ),
      ).toEqual([]);
      // Neither window's run leaked into the process-default machine.
      expect(registry.defaultSession().status.get(streamA)).toBeUndefined();
      expect(registry.defaultSession().status.get(streamB)).toBeUndefined();

      // One window's delete-all sweep (bridge path AND machine path) cannot
      // reset the sibling's streams — the exact L3 clearAll leak.
      await windowB.bridge.deleteAllStreams();
      windowB.session.status.clearAll();
      expect(windowA.session.status.get(streamA)).toBe(STREAM_PHASE.COMPLETED);
      expect(windowB.session.status.get(streamB)).toBeUndefined();
    });
  });

  // #8148: closing a desktop window deliberately keeps active executions
  // alive while tearing down the old bridge's UI consumers. A replacement
  // window must rebind canonical startup streams to those headless runs.
  describe('window recreation rebind (#8148)', () => {
    async function createReboundOwner({
      streamId,
      executionId,
      agentName = 'proofreader',
      category = AgentCategory.Workflow,
      messages = [],
    }: {
      streamId: StreamTabId;
      executionId: ExecutionId;
      agentName?: string;
      category?: AgentCategory;
      messages?: unknown[];
    }) {
      let activeExecutionIds: readonly string[] = [];
      const { bridgeModule, createProgressSnapshotStore, openTranscripts } =
        await loadBridgeModule({
          activeExecutionIds: () => activeExecutionIds,
        });
      const { AgentExecutionHandle, ProcessExecutionHandle } =
        await import('@agent/runtime/ExecutionHandle');
      const { noopAgentRuntimeHost } =
        await import('@agent/runtime/AgentRuntimeHost');
      const transcriptsA = await openTranscripts();
      const bridgeA = new bridgeModule.DesktopProgressBridge(
        (message) => {
          messages.push(message);
        },
        {
          transcripts: transcriptsA,
          progressSnapshotStore: createProgressSnapshotStore(),
          host: createStubDesktopAgentExecutionHost(),
        },
      ) as unknown as TestableBridge & { session: SessionHandle };
      await bridgeA.waitUntilReady();
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
          noopAgentRuntimeHost,
          nextTrace as unknown as ConstructorParameters<
            typeof AgentExecutionHandle
          >[6],
        );
        return { handle: nextHandle, trace: nextTrace };
      };
      const { handle, trace } = createHandle();
      bridgeA.session.executions.trackAgentExecution(handle, {
        status: STREAM_PHASE.RUNNING,
      });
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        activeExecutionIds = [executionId];
        bridgeA.dispose();
      };

      const reopen = async (reopenedMessages: unknown[] = []) => {
        close();
        const transcripts = await openTranscripts();
        transcripts.ensureStream(streamId);
        const progressSnapshotStore = createProgressSnapshotStore();
        await progressSnapshotStore.load([streamId]);
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
        const bridgeB = new bridgeModule.DesktopProgressBridge(
          (message) => {
            reopenedMessages.push(message);
          },
          {
            transcripts,
            progressSnapshotStore,
            host: createStubDesktopAgentExecutionHost(),
          },
        ) as unknown as TestableBridge & {
          session: SessionHandle;
        };
        await bridgeB.waitUntilReady();
        return { bridgeB, progressSnapshotStore };
      };

      return {
        ProcessExecutionHandle,
        bridgeA,
        close,
        createHandle,
        handle,
        noopAgentRuntimeHost,
        reopen,
        trace,
      };
    }

    it('seeds the canonical rebound stream with the live owning session status', async () => {
      const streamId = 'rebound-stream-2' as StreamTabId;
      const executionId = 'ec00dd' as ExecutionId;
      const owner = await createReboundOwner({
        streamId,
        executionId,
      });
      owner.close();

      // Owner status stays live while the replacement window starts.
      expect(
        owner.bridgeA.session.status.transitionToWaiting(streamId, 'wait', {
          trace: owner.trace as unknown as AgentTrace,
        }),
      ).toBe(true);
      expect(owner.bridgeA.session.status.get(streamId)).toBe(
        STREAM_PHASE.WAITING,
      );

      const { bridgeB } = await owner.reopen();

      try {
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          owner.handle,
        );
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
      } finally {
        bridgeB.dispose();
      }
    });

    it('forwards the owner session host interactions to the reopened window (#8227)', async () => {
      const streamId = 'rebound-stream-3' as StreamTabId;
      const executionId = 'ec00ee' as ExecutionId;
      const messagesA: unknown[] = [];
      const owner = await createReboundOwner({
        streamId,
        executionId,
        messages: messagesA,
      });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        await bridgeB.waitUntilReady();

        // The retained run still resolves interactions through window A.
        const planPromise = bridgeInteractions(
          owner.bridgeA,
        ).requestPlanApproval?.({
          approvalId: 'plan-rebound',
          streamId,
          plan: { objective: 'Prove approvals reach the new window.' },
          goalEnabled: false,
        });
        expect(planPromise).toBeDefined();

        // The forwarded prompt surfaces only in window B.
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

        // Window B resolves the retained run's pending interaction.
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

    it('replays a tool-edit approval with a fresh window request id', async () => {
      const streamId = 'rebound-stream-tool-edit' as StreamTabId;
      const executionId = 'ec00ed' as ExecutionId;
      const messagesA: unknown[] = [];
      const owner = await createReboundOwner({
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

      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);
      try {
        await bridgeB.waitUntilReady();
        let newRequestId = '';
        await vi.waitFor(() => {
          newRequestId = shownToolEditRequestId(messagesB) ?? '';
          expect(newRequestId).not.toBe('');
        });
        expect(newRequestId).not.toBe(oldRequestId);

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
      const owner = await createReboundOwner({ streamId, executionId });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);
      await bridgeB.waitUntilReady();

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
      const owner = await createReboundOwner({
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
        await bridgeB.waitUntilReady();

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
          false,
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

    it('releases rebound stream interactions from the durable owner session', async () => {
      const streamId = 'rebound-stream-delete' as StreamTabId;
      const executionId = 'ec00f9' as ExecutionId;
      const owner = await createReboundOwner({ streamId, executionId });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        await bridgeB.waitUntilReady();
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

    it('rebinds still-active child subagent and process handles so stops cascade from the new window (#8228)', async () => {
      const streamId = 'rebound-stream-4' as StreamTabId;
      const childStreamId = 'rebound-child-4' as StreamTabId;
      const executionId = 'ec00f0' as ExecutionId;
      const childExecutionId = 'ec00f1' as ExecutionId;
      const processExecutionId = 'ec00f2' as ExecutionId;
      const owner = await createReboundOwner({
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
      const { bridgeB } = await owner.reopen();

      try {
        await bridgeB.waitUntilReady();
        // Children launched after startup repair are observed for root life.
        owner.bridgeA.session.executions.trackAgentExecution(childHandle, {
          status: STREAM_PHASE.RUNNING,
        });
        owner.bridgeA.session.executions.track(processHandle);

        // Both children and the child status are now visible in window B.
        expect(bridgeB.session.executions.getHandle(childExecutionId)).toBe(
          childHandle,
        );
        expect(bridgeB.session.executions.getHandle(processExecutionId)).toBe(
          processHandle,
        );
        expect(bridgeB.session.status.get(childStreamId)).toBe(
          STREAM_PHASE.RUNNING,
        );

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
        owner.bridgeA.session.executions.track(freshChildHandle);
        expect(bridgeB.session.executions.getHandle(childExecutionId)).toBe(
          freshChildHandle,
        );

        // Stop cascades through root, current child turn, and process.
        bridgeB.session.executions.stopAgentStream(streamId);
        expect(rootInterrupt).toHaveBeenCalledTimes(1);
        expect(childInterrupt).not.toHaveBeenCalled();
        expect(freshChildInterrupt).toHaveBeenCalledTimes(1);
        expect(killProcess).toHaveBeenCalledTimes(1);

        // Owner-side process removal clears the mirrored entry too.
        owner.bridgeA.session.executions.untrack(processExecutionId);
        expect(
          bridgeB.session.executions.getHandle(processExecutionId),
        ).toBeUndefined();

        // Owner-side child removal clears both registries.
        freshChildHandle.settleResult({
          type: 'result',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId: childExecutionId,
          streamId: childStreamId,
          agentName: 'searcher',
          category: 'toolUse',
          isSubagent: true,
        } as unknown as Parameters<typeof freshChildHandle.settleResult>[0]);
        owner.bridgeA.session.executions.untrack(childExecutionId);
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

    it('seeds live RUNNING and mirrors later owner transitions (#8230, #8231)', async () => {
      const streamId = 'rebound-stream-5' as StreamTabId;
      const executionId = 'ec00f3' as ExecutionId;
      const owner = await createReboundOwner({
        streamId,
        executionId,
      });
      const { bridgeB } = await owner.reopen();
      const resultsSeenByB: unknown[] = [];
      const detachResult = bridgeB.session.onResult((event) => {
        resultsSeenByB.push(event);
      });

      try {
        await bridgeB.waitUntilReady();

        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          owner.handle,
        );
        // Rebind seeds the replacement window from the live owner.
        expect(bridgeB.session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);

        // Later owner transitions continue mirroring into window B.
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

        // A later owner turn replaces both handle and trace.
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
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
          agentName: 'proofreader',
          category: 'workflow' as const,
          isSubagent: false,
        };
        freshTrace.emit(resultEvent);
        expect(resultsSeenByB).toContainEqual(resultEvent);
        expect(bridgeB.session.status.get(streamId)).toBe(
          STREAM_PHASE.COMPLETED,
        );
        owner.bridgeA.session.executions.untrack(executionId);
        expect(
          bridgeB.session.executions.getHandle(executionId),
        ).toBeUndefined();
      } finally {
        detachResult();
        bridgeB.dispose();
      }
    });

    it('detaches agent and process mirrors when the reopened window closes', async () => {
      const streamId = 'rebound-stream-dispose' as StreamTabId;
      const executionId = 'ec00f5' as ExecutionId;
      const processExecutionId = 'ec00f6' as ExecutionId;
      const owner = await createReboundOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();
      await bridgeB.waitUntilReady();

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
      expect(bridgeB.session.executions.getHandle(executionId)).toBeUndefined();
      expect(
        bridgeB.session.executions.getHandle(processExecutionId),
      ).toBeUndefined();

      const { handle: freshHandle } = owner.createHandle();
      owner.bridgeA.session.executions.track(freshHandle);
      owner.bridgeA.session.executions.untrack(processExecutionId);
      expect(bridgeB.session.executions.getHandle(executionId)).toBeUndefined();
      expect(
        bridgeB.session.executions.getHandle(processExecutionId),
      ).toBeUndefined();
      owner.bridgeA.session.executions.untrack(executionId);
    });

    it('releases the original session registration when a resume supersedes the rebound handle (#8229)', async () => {
      const streamId = 'rebound-stream-6' as StreamTabId;
      const executionId = 'ec00f4' as ExecutionId;
      const owner = await createReboundOwner({
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
        await bridgeB.waitUntilReady();
        expect(bridgeB.session.executions.getHandle(executionId)).toBe(
          owner.handle,
        );

        // Local resume replaces the rebound handle under the same id.
        const { handle: freshHandle } = owner.createHandle();
        bridgeB.session.executions.track(freshHandle);
        expect(
          bridgeB.session.status.transition(
            streamId,
            STREAM_PHASE.RUNNING,
            'resume',
          ),
        ).toBe(true);

        // The replacement releases window A's stale registration.
        expect(
          owner.bridgeA.session.executions.getHandle(executionId),
        ).toBeUndefined();
        // Identity-safe cleanup preserves the fresh local handle.
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

    it('publishes mirrored owner status changes as updateStreamStatus session facts (#8256)', async () => {
      const streamId = 'rebound-stream-7' as StreamTabId;
      const executionId = 'ec00f7' as ExecutionId;
      const owner = await createReboundOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();
      const facts: SessionFact[] = [];
      const detachFacts = bridgeB.session.events.subscribe(
        (event) => {
          if (event.scope === 'session') facts.push(event.event);
        },
        { scope: 'session' },
      );

      try {
        await bridgeB.waitUntilReady();

        // A bare owner-machine transition (no live trace) must still reach
        // the reopened window's UI as a session fact.
        expect(
          owner.bridgeA.session.status.transitionToWaiting(streamId, 'wait'),
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

    it('mirrors a child terminal status that lands after the owner untracks (#8257)', async () => {
      const streamId = 'rebound-stream-8' as StreamTabId;
      const childStreamId = 'rebound-child-8' as StreamTabId;
      const executionId = 'ec00f8' as ExecutionId;
      const childExecutionId = 'ec00f9' as ExecutionId;
      const owner = await createReboundOwner({ streamId, executionId });
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
        await bridgeB.waitUntilReady();
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

        // The terminal mirror was the binding's last act; later owner-machine
        // transitions for the finished child no longer mirror.
        expect(
          owner.bridgeA.session.status.transition(
            childStreamId,
            STREAM_PHASE.RUNNING,
            'resume',
          ),
        ).toBe(true);
        expect(bridgeB.session.status.get(childStreamId)).toBe(
          STREAM_PHASE.COMPLETED,
        );
      } finally {
        detachFacts();
        bridgeB.dispose();
      }
    });

    it('mirrors a terminal owner status onto a WAITING target through resume choreography', async () => {
      const streamId = 'rebound-stream-12' as StreamTabId;
      const executionId = 'ec00fe' as ExecutionId;
      const owner = await createReboundOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();

      try {
        await bridgeB.waitUntilReady();

        // A target-local wait skews the machines: the target sits at WAITING
        // while the owner finishes from RUNNING. The terminal mirror must go
        // through transitionToTerminal's resume choreography, not the plain
        // cause-preserving transition (which rejects WAITING -> terminal).
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

    it('replays initial run config and description for descendants bound after tracking (#8258)', async () => {
      const streamId = 'rebound-stream-9' as StreamTabId;
      const childStreamId = 'rebound-child-9' as StreamTabId;
      const executionId = 'ec00fa' as ExecutionId;
      const childExecutionId = 'ec00fb' as ExecutionId;
      const owner = await createReboundOwner({ streamId, executionId });
      const { bridgeB, progressSnapshotStore } = await owner.reopen();
      const childConfig = {
        agent: 'searcher',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        toolConfig: DEFAULT_TOOL_CONFIG,
      } as unknown as AgentConfig;
      const events: SessionEvent[] = [];
      const detachEvents = bridgeB.session.events.subscribe((event) => {
        events.push(event);
      });

      try {
        await bridgeB.waitUntilReady();

        // Spawn a child AFTER the root was rebound: its run.config and
        // description fired on the owner side before tracking, so only the
        // handle-carried replay can deliver them to the reopened window.
        const { handle: childHandle } = owner.createHandle({
          executionId: childExecutionId,
          childStreamId,
          agentName: 'searcher',
          category: AgentCategory.ToolUse,
        });
        childHandle.initialRunFacts = {
          config: childConfig,
          description: 'Search the docs',
        };
        owner.bridgeA.session.executions.trackAgentExecution(childHandle, {
          status: STREAM_PHASE.RUNNING,
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
        expect(progressSnapshotStore.getExecutionId(childStreamId)).toBe(
          childExecutionId,
        );
        expect(progressSnapshotStore.getRunConfig(childStreamId)?.agent).toBe(
          'searcher',
        );
        expect(progressSnapshotStore.getDescription(childStreamId)).toBe(
          'Search the docs',
        );
      } finally {
        detachEvents();
        bridgeB.dispose();
      }
    });
  });
});
