// Node imports
import { access } from 'node:fs/promises';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  noopTrace,
  type AgentEvent,
  type AgentTrace,
  type ResultEvent,
} from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent, SessionFact } from '@agent/runtime/SessionEventHub';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { PlanApprovalResult } from '@agent/runtime/HostInteractions';
import {
  AgentConfigSchema,
  WorkflowAgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { DESKTOP_SHELL_COMMANDS } from '@desktop/shared/desktopShellMessages';
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
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
} from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { assertSupported } from '@shared/utils/dispatcher';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createModuleMocks } from '@test/support/moduleMocks';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { seedStreamStatusForTest } from '@test/support/streamStatusTestUtils';
import type { PayloadSessionFact } from '@test/agent/progressTestUtils';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
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
} from './desktopAgentExecutionTestHarness.ts';
import { loadSourceModule } from './loadSourceModule.ts';

const mocks = createModuleMocks();

type DesktopProgressBridgeOptions =
  import('@desktop/main/desktopAgentExecution').DesktopProgressBridgeOptions;

type TestableBridge = {
  dispose(): void;
  fileActions: {
    host: { startExecution(request: unknown): void };
  };
  hostInteractions: {
    submitPlanDecision(
      requestId: string,
      decision: PlanApprovalResult,
    ): boolean;
    submitRetryDecision(
      streamId: StreamTabId,
      requestId: string,
      decision: { action: 'retry' | 'cancel'; feedback?: string },
    ): boolean;
  };
  waitUntilReady(): Promise<void>;
  interactions: {
    emit(event: string, payload: unknown): void;
  };
  handlePresentationEvent(event: string, payload: unknown): void;
  syncFullView(): void;
  completeWebviewReady(): Promise<void>;
  sendFollowUp(
    streamId: StreamTabId,
    text: string,
    mediaFiles?: readonly string[],
  ): Promise<void>;
  setActiveStream(streamId: StreamTabId): void;
  revealStream(streamId: StreamTabId): Promise<'revealed' | 'missing'>;
  progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;
  streamLogs: {
    acquireWriter(
      streamId: StreamTabId,
      ownerKey: string,
    ): {
      append(entry: {
        id: string;
        type: string;
        level: string;
        timestamp: number;
        text: string;
      }): unknown;
      close(): void;
    };
    requestEviction(streamId: StreamTabId): void;
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

/** The request shapes these tests drive through the session's host
 * interactions, kept structural so tests can post plain fixture objects. */
type BridgeInteractions = {
  requestPlanApproval?: (request: {
    approvalId: string;
    streamId: StreamTabId;
    plan: { objective: string };
    goalEnabled: boolean;
  }) => Promise<unknown>;
  requestAgentProposal?: (request: unknown) => Promise<unknown>;
  requestRetry?: (request: {
    requestId: string;
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

/** Test-side record of what each bridge was constructed with. Tests pass the
 * session and snapshot store into the constructor themselves, so they assert
 * on those references rather than reaching into the bridge's private fields. */
type BridgeTestContext = {
  session: SessionHandle;
  snapshots: ProgressSnapshotStore;
  ctor: DesktopAgentExecutionModule['DesktopProgressBridge'];
  options: DesktopProgressBridgeOptions;
};

const bridgeContexts = new WeakMap<TestableBridge, BridgeTestContext>();

function bridgeContext(bridge: TestableBridge): BridgeTestContext {
  const context = bridgeContexts.get(bridge);
  if (!context) {
    throw new Error('Bridge was not created by this test file.');
  }
  return context;
}

function bridgeSession(bridge: TestableBridge): SessionHandle {
  return bridgeContext(bridge).session;
}

function bridgeSnapshots(bridge: TestableBridge): ProgressSnapshotStore {
  return bridgeContext(bridge).snapshots;
}

function bridgeInteractions(bridge: TestableBridge): BridgeInteractions {
  return bridgeSession(bridge).interactions as unknown as BridgeInteractions;
}

function bridgeStatus(bridge: TestableBridge): StreamStatusMachine {
  return bridgeSession(bridge).status;
}

/** Drive stream deletion through the same inbound command path the
 * renderer uses, so these tests cover the production wiring. */
async function deleteStreamViaInbound(
  bridge: TestableBridge,
  stream: StreamTabId,
): Promise<void> {
  const handler = assertSupported(
    bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.DELETE_STREAM],
  );
  await handler({ command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM, stream });
}

async function deleteAllStreamsViaInbound(
  bridge: TestableBridge,
): Promise<void> {
  const handler = assertSupported(
    bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.DELETE_ALL],
  );
  await handler({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
}

function bridgeFollowUps(bridge: TestableBridge): SessionHandle['followUps'] {
  return bridgeSession(bridge).followUps;
}

function seedBridgeFollowUp(
  bridge: TestableBridge,
  streamId: StreamTabId,
  text: string,
): void {
  const followUps = bridgeFollowUps(bridge);
  const lease = followUps.claimLive(streamId, 'flow')!;
  followUps.queue(lease).enqueue({ text });
  followUps.release(lease, 'recoverable');
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
  showErrorMessage?: (message: string) => Promise<void> | void;
  showInfoMessage?: (message: string) => Promise<void> | void;
  onRunCompleted?: () => void;
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
  executionId?: string;
  stdout?: string;
  stderr?: string;
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
  createSession(
    transcripts: StreamLogStore,
    snapshots: ProgressSnapshotStore,
  ): SessionHandle;
  createProgressSnapshotStore(): ProgressSnapshotStore;
  processResumeOwner: import('@desktop/main/desktopAgentResume').DesktopProcessResumeOwner;
  progressSnapshotStore: ProgressSnapshotStore;
}> {
  vi.resetModules();
  const kvStoreBacking = options.kvStoreBacking ?? new Map<string, unknown>();
  let resumeDelegate: AgentResumePort = {
    tryResumeStream: async () => false,
  };
  const agentResume: AgentResumePort = {
    tryResumeStream: (streamId, recovery) =>
      resumeDelegate.tryResumeStream(streamId, recovery),
  };
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform({}, { agentResume }));
  mocks.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData:
      options.retrieveSessionResumeData ?? vi.fn(async () => null),
  }));
  mocks.doMock('@agent/runtime/executeAgent', () => ({
    resumeToolUseFromResumeData:
      options.resumeToolUseFromResumeData ?? vi.fn(async () => {}),
  }));
  mocks.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(),
  }));
  mocks.doMock('@agent/storage/detectWaitingStreams', () => ({
    detectWaitingStreams:
      options.detectWaitingStreams ?? vi.fn(async () => new Set()),
  }));
  mocks.doMock('@common/storage/KVStore', () => ({
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

      async exists(key: string): Promise<boolean> {
        return kvStoreBacking.has(this.key(key));
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
  mocks.doMock('@controllers/mainView/MainViewExecutionController', () => ({
    prepareMainViewExecutionRequest: vi.fn(),
  }));
  const { StreamLogStore, StreamSnapshotStore } = await import('@transcript');
  const createProgressSnapshotStore = (): ProgressSnapshotStore =>
    new StreamSnapshotStore();
  const progressSnapshotStore = createProgressSnapshotStore();
  const bridgeModule = await loadSourceModule(
    '@desktop/main/desktopAgentExecution',
  );
  const { DesktopProcessResumeOwner } =
    await import('@desktop/main/desktopAgentResume');
  const processResumeOwner = new DesktopProcessResumeOwner();
  resumeDelegate = processResumeOwner;
  const { initializeDefaultSession, SessionHandle } =
    await import('@agent/runtime/SessionHandle');
  initializeDefaultSession({
    transcripts: StreamLogStore.ephemeral('desktop module test default'),
    restartRepair: 'deferred',
  });
  return {
    bridgeModule,
    createSession: (transcripts, snapshots) =>
      new SessionHandle({
        transcripts,
        snapshots,
        restartRepair: 'deferred',
      }),
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
  const session = createSession(transcripts, progressSnapshotStore);
  const { attachTerminalResultToast } =
    await import('@agent/runtime/terminalResultToast');
  const detachTerminalResultToast = attachTerminalResultToast(
    session,
    session.interactions,
    { replayWhenAttached: true },
  );
  const { SessionStores } = await import('@agent/storage');
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
  const disposeResumeHandler = processResumeOwner.attach({ session });
  await options.configureSession?.(session);
  const sessionReady = session.waitUntilReady();
  if (!options.deferReady) await sessionReady;
  const bridgeOptions: DesktopProgressBridgeOptions = {
    session,
    sessionStores,
    ...(options.loggerErrorSpy
      ? { logger: { ...noopTrace, error: options.loggerErrorSpy } }
      : {}),
    host: createStubDesktopAgentExecutionHost({
      ...(options.showErrorMessage
        ? { showErrorMessage: options.showErrorMessage }
        : {}),
      ...(options.showInfoMessage
        ? { showInfoMessage: options.showInfoMessage }
        : {}),
      ...(options.onRunCompleted
        ? { onRunCompleted: options.onRunCompleted }
        : {}),
      ...(options.openPath ? { openPath: options.openPath } : {}),
    }),
  };
  const bridge = new bridgeModule.DesktopProgressBridge((message) => {
    options.observeRendererMessage?.(message);
    messages.push(message);
  }, bridgeOptions) as unknown as TestableBridge;
  bridgeContexts.set(bridge, {
    session,
    snapshots: progressSnapshotStore,
    ctor: bridgeModule.DesktopProgressBridge,
    options: bridgeOptions,
  });
  const waitForPresentation = bridge.waitUntilReady.bind(bridge);
  bridge.waitUntilReady = async () => {
    await sessionReady;
    await waitForPresentation();
  };
  disposeAfterTest({
    dispose: () => {
      bridge.dispose();
      disposeResumeHandler();
      detachTerminalResultToast();
      session.dispose();
    },
  });
  if (!options.deferReady) await bridge.waitUntilReady();
  return bridge;
}

/**
 * Resume moved off the bridge: desktop stream resumption is owned by the
 * process resume owner reached through `platform().agentResume`, which the
 * harness attaches to the same session the bridge runs on.
 */
async function tryResumeStream(streamId: string): Promise<boolean> {
  const { platform } = await import('@platform/platform');
  return platform().agentResume.tryResumeStream(streamId as StreamTabId);
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

type PermissionKind = (typeof PERMISSION_KIND)[keyof typeof PERMISSION_KIND];

function shownPermissionRequestId(
  messages: unknown[],
  kind: PermissionKind,
): string | undefined {
  for (const message of progressMessages(
    messages,
    PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
  )) {
    const update = message as ProgressMessage & {
      action?: string;
      permission?: { kind?: string; data?: { requestId?: string } };
    };
    if (update.action === 'show' && update.permission?.kind === kind) {
      return update.permission.data?.requestId;
    }
  }
  return undefined;
}

/** Waits for the renderer to be shown a matching pending permission. */
async function waitForShownPermission(
  messages: unknown[],
  match: { kind?: PermissionKind; data?: Record<string, unknown> },
): Promise<void> {
  const permission: Record<string, unknown> = {};
  if (match.kind !== undefined) permission.kind = match.kind;
  if (match.data !== undefined) {
    permission.data = expect.objectContaining(match.data);
  }
  await vi.waitFor(() => {
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    ).toContainEqual(
      expect.objectContaining({
        action: 'show',
        permission: expect.objectContaining(permission),
      }),
    );
  });
}

describe('desktop follow-up submission', () => {
  it('does not hold the IPC request open for the resumed turn', async () => {
    const streamId = 'desktop-detached-follow-up' as StreamTabId;
    let finishResumeLookup!: (value: null) => void;
    const resumeLookup = new Promise<null>((resolve) => {
      finishResumeLookup = resolve;
    });
    const bridge = await createBridge([], {
      retrieveSessionResumeData: vi.fn(() => resumeLookup),
      configureSession: (session) => {
        seedStreamStatusForTest(session.status, streamId, {
          phase: STREAM_PHASE.WAITING,
        });
      },
    });

    await expect(bridge.sendFollowUp(streamId, 'continue')).resolves.toBe(
      undefined,
    );
    expect(bridgeFollowUps(bridge).getAll(streamId)).toEqual(['continue']);

    finishResumeLookup(null);
    await vi.waitFor(() =>
      expect(bridgeFollowUps(bridge).getAll(streamId)).toEqual(['continue']),
    );
  });
});

function appendRunningGroup(
  store: StreamLogStore,
  streamId: StreamTabId,
): void {
  appendTranscriptEntry(store, streamId, {
    id: `${streamId}-running-group`,
    type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
    level: LOG_LEVELS.INFO,
    timestamp: 1_000,
    data: { status: STREAM_PHASE.RUNNING },
  });
}

function workflowConfig(): AgentConfig {
  return WorkflowAgentConfigSchema.parse({
    agent: 'proofreader',
    model: 'deepseekproT',
    agentCategory: AgentCategory.Workflow,
    toolConfig: DEFAULT_TOOL_CONFIG,
  });
}

function expectWorkflowResume(
  runAgent: ReturnType<typeof vi.fn>,
  config: AgentConfig,
  executionId: string,
): void {
  expect(runAgent).toHaveBeenCalledWith(
    {
      config: expect.objectContaining(config),
      executionId,
    },
    expect.objectContaining({
      openWorkflowOutput: expect.any(Function),
    }),
  );
}

async function settleProgressEvents(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function emitSessionFact<K extends PayloadSessionFact['type']>(
  bridge: TestableBridge,
  type: K,
  payload: Extract<PayloadSessionFact, { type: K }>['payload'],
): void {
  bridgeSession(bridge).events.emit({
    scope: 'session',
    event: { type, payload } as Extract<SessionFact, { type: K }>,
  });
}

function emitRunEvent(
  bridge: TestableBridge,
  streamId: StreamTabId,
  event: AgentEvent,
): void {
  bridgeSession(bridge).events.emit({
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
    config: unknown;
  },
): void {
  emitRunEvent(bridge, payload.streamId, {
    type: 'run.config',
    streamId: payload.streamId,
    executionId: payload.executionId,
    config: payload.config as AgentConfig,
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
  // Status reaches the bridge on the canonical session-fact rail only; no
  // projector reads run-scope `status` trace events any more.
  bridgeSession(bridge).events.emit({
    scope: 'session',
    event: {
      type: 'status',
      streamId: payload.streamId,
      phase: payload.status,
      ...(payload.previousStatus
        ? { previousPhase: payload.previousStatus }
        : {}),
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
    },
  });
}

function completedRootResult(executionId: ExecutionId): ResultEvent {
  return {
    type: 'result',
    outcome: RUN_OUTCOME.COMPLETED,
    executionId,
    streamId: 'onboarding-completed',
    agentName: 'proofreader',
    category: 'workflow',
    isSubagent: false,
  };
}

/** The rejection every stream-scoped interaction settles with when the
 * stream's resources are released (delete, delete-all, headless cleanup). */
const STREAM_RELEASED_REJECTION = {
  action: 'reject',
  cause: 'Stream resources released.',
} as const;

function activateStream(bridge: TestableBridge, streamId: string): void {
  emitSessionFact(bridge, 'setActiveStream', {
    streamId,
    agentCategory: AgentCategory.Workflow,
  });
}

function lastStreamSync(messages: unknown[]): ProgressMessage | undefined {
  return progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS).at(
    -1,
  );
}

function lastContentSync(messages: unknown[]): ProgressMessage | undefined {
  return progressMessages(
    messages,
    PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
  ).at(-1);
}

function expectPermissionResolved(
  messages: unknown[],
  kind: PermissionKind,
  id: string,
): void {
  expect(
    progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
  ).toContainEqual(expect.objectContaining({ action: 'resolve', kind, id }));
}

function expectLastLogGroupEnd(
  streamLogs: TestableBridge['streamLogs'],
  streamId: StreamTabId,
  status: string,
): void {
  expect(streamLogs.get(streamId)?.getRange(0).at(-1)).toMatchObject({
    type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
    data: { status },
  });
}

/** detectWaitingStreams mock that blocks restart initialization on a gate. */
function gatedWaitingDetection(): {
  initializationStarted: ReturnType<typeof createDeferred<void>>;
  initializationGate: ReturnType<typeof createDeferred<void>>;
  detectWaitingStreams: ReturnType<typeof vi.fn>;
} {
  const initializationStarted = createDeferred();
  const initializationGate = createDeferred();
  const detectWaitingStreams = vi.fn(async () => {
    initializationStarted.resolve();
    await initializationGate.promise;
    return new Set();
  });
  return { initializationStarted, initializationGate, detectWaitingStreams };
}

function searchToolUseResumeData(): ReturnType<typeof createToolUseResumeData> {
  return createToolUseResumeData({
    executionId: 'ec1001' as ExecutionId,
    streamId: 'stream-1' as StreamTabId,
    agentConfig: SEARCH_TOOL_USE_AGENT_CONFIG,
  });
}

function emitSearchRunConfig(bridge: TestableBridge): void {
  emitRunConfigFact(bridge, {
    streamId: 'stream-1' as StreamTabId,
    executionId: 'ec1001' as ExecutionId,
    config: SEARCH_TOOL_USE_AGENT_CONFIG,
  });
}

function stubWorkflowResumeData(
  runConfig: AgentConfig,
  executionId: string,
): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    type: 'workflow',
    agentConfig: runConfig,
    executionId,
  }));
}

/** Creates a bridge with the given runAgent mock and starts one workflow
 * execution through the host file actions. */
async function startMergeExecution(runAgent: RunExecutionRequest): Promise<{
  bridge: TestableBridge;
  showErrorMessage: ReturnType<typeof vi.fn>;
}> {
  const showErrorMessage = vi.fn(async () => undefined);
  const bridge = await createBridge([], { runAgent, showErrorMessage });
  bridge.fileActions.host.startExecution({ config: workflowConfig() });
  return { bridge, showErrorMessage };
}

/** Builds a bridge behind a transcript-open gate, asserts nothing reaches the
 * renderer before the gate opens, releases it, and runs `body`. */
async function openTranscriptGatedBridge(
  messages: unknown[],
  options: Omit<CreateBridgeOptions, 'transcriptOpenGate'>,
  body: (bridge: TestableBridge) => Promise<void>,
): Promise<void> {
  const transcriptOpen = createDeferred();
  const opening = createBridge(messages, {
    ...options,
    transcriptOpenGate: transcriptOpen.promise,
  });
  const opened = vi.fn();
  void opening.then(opened);
  let bridge: TestableBridge | undefined;
  try {
    await settleProgressEvents();
    expect(opened).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    transcriptOpen.resolve();
    bridge = await opening;
    await body(bridge);
  } finally {
    transcriptOpen.resolve();
    bridge?.dispose();
  }
}

describe('DesktopProgressBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes process-session facts to the attached desktop backend', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'parent');
    await settleProgressEvents();
    bridge.syncFullView();

    expect(lastStreamSync(messages)).toMatchObject({
      activeStream: 'parent',
      streams: [expect.objectContaining({ name: 'parent' })],
    });
  });

  it('reports a completed root result while canonical initialization is gated exactly once', async () => {
    const { initializationStarted, initializationGate, detectWaitingStreams } =
      gatedWaitingDetection();
    const onRunCompleted = vi.fn();
    const bridge = await createBridge([], {
      deferReady: true,
      detectWaitingStreams,
      onRunCompleted,
    });
    await initializationStarted.promise;

    const session = bridgeSession(bridge);
    session.publishRunEvent(
      'onboarding-completed',
      completedRootResult('onboarding-completed-1' as ExecutionId),
    );
    expect(onRunCompleted).toHaveBeenCalledOnce();

    initializationGate.resolve();
    await bridge.waitUntilReady();
    expect(onRunCompleted).toHaveBeenCalledOnce();
  });

  it('detaches the completed-result listener when disposed during initialization', async () => {
    const { initializationStarted, initializationGate, detectWaitingStreams } =
      gatedWaitingDetection();
    const onRunCompleted = vi.fn();
    const bridge = await createBridge([], {
      deferReady: true,
      detectWaitingStreams,
      onRunCompleted,
    });
    await initializationStarted.promise;

    bridge.dispose();
    const session = bridgeSession(bridge);
    session.publishRunEvent(
      'onboarding-completed',
      completedRootResult('onboarding-completed-2' as ExecutionId),
    );
    expect(onRunCompleted).not.toHaveBeenCalled();

    initializationGate.resolve();
    await bridge.waitUntilReady();
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it('keeps desktop runtime host app events on the window-local bridge path', async () => {
    const messages: unknown[] = [];
    const showErrorMessage = vi.fn();
    const showInfoMessage = vi.fn();
    const bridge = await createBridge(messages, {
      showErrorMessage,
      showInfoMessage,
    });
    messages.length = 0;

    bridge.handlePresentationEvent('requestEnsureProgressView', {});
    bridge.handlePresentationEvent('requestEnsureProgressView', {
      fallbackNotification: {
        agentName: 'writer',
        modelName: 'test-model',
        inputName: 'paper.tex',
        outputInfo: 'to paper.out.tex',
      },
    });
    bridge.handlePresentationEvent('requestShowError', {
      message: 'Root run failed',
    });
    bridge.handlePresentationEvent('requestShowInstruction', {
      key: 'missingApiKey',
      message: 'API key not found. Set your API key in Settings and run again.',
      actions: ['set-api-key', 'open-configuration-guide'],
      showSuppress: false,
    });
    bridge.handlePresentationEvent('showAgentConfigBanner', {
      agentName: 'missing-writer',
    });

    expect(messages).toContainEqual({
      command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
      agentName: 'missing-writer',
      customDirSet: true,
    });
    expect(messages).toHaveLength(1);
    expect(showErrorMessage).toHaveBeenCalledWith('Root run failed');
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    // Instructions are actionable guidance, not failures: they use the info
    // dialog, with action tokens rendered as trailing hint text.
    expect(showInfoMessage).toHaveBeenCalledWith(
      'API key not found. Set your API key in Settings and run again. ' +
        '(set your API key in Settings, see the configuration guide)',
    );
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
    bridge.interactions?.emit('requestEnsureProgressView', {});
    bridge.interactions?.emit('requestShowError', { message: 'late error' });
    bridge.interactions?.emit('requestOpenFile', {
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

    bridge.handlePresentationEvent('requestOpenFile', {
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

    await waitForShownPermission(messages, {
      kind: PERMISSION_KIND.PLAN_APPROVAL,
      data: { approvalId: 'plan-host-interaction' },
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
    expectPermissionResolved(
      messages,
      PERMISSION_KIND.PLAN_APPROVAL,
      'plan-host-interaction',
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

    await waitForShownPermission(messages, {
      kind: PERMISSION_KIND.PROPOSAL,
      data: { proposalId: 'proposal-host-interaction' },
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
    expectPermissionResolved(
      messages,
      PERMISSION_KIND.PROPOSAL,
      'proposal-host-interaction',
    );
  });

  it('surfaces a retry request to the user instead of auto-cancelling it', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    messages.length = 0;
    // The request must stay pending until the renderer settles it, so don't
    // await the promise here: an auto-cancel would terminate the run with
    // "Retry cancelled by user" without ever asking.
    const pending = bridgeInteractions(bridge).requestRetry?.({
      requestId: 'retry-host-interaction',
      streamId: 'stream-retry' as StreamTabId,
      operation: 'model request',
    });

    await waitForShownPermission(messages, { kind: PERMISSION_KIND.RETRY });

    // A cancel decision from the renderer still resolves it the same way.
    bridge.hostInteractions.submitRetryDecision(
      'stream-retry' as StreamTabId,
      shownPermissionRequestId(messages, PERMISSION_KIND.RETRY) ?? '',
      { action: 'cancel' },
    );
    await expect(pending).resolves.toEqual({ action: 'cancel' });
  });

  it('preserves progress and badge metadata across repeated stream syncs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'parent');
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
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      parentStreamId: 'parent',
      items: [
        {
          childStreamId: 'agent-1',
          executionId: 'agent-1',
          agentName: 'reviewer',
          identity: { kind: 'agent' as const, agent: 'reviewer' },
        },
      ],
    });
    await settleProgressEvents();
    messages.length = 0;
    bridge.syncFullView();

    const streamSync = lastStreamSync(messages);
    expect(streamSync?.streams?.find((s) => s.name === 'parent')).toMatchObject(
      {
        creationTimestamp: 1_000,
      },
    );
    expect(streamSync?.streamStates?.parent).toMatchObject({
      conversationProgress: { toolCallCount: 5 },
      stage: { kind: 'round', index: 2 },
      subagents: [{ executionId: 'agent-1', agentName: 'reviewer' }],
    });
  });

  it('retains a finished child as a full row', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'parent');
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      parentStreamId: 'parent',
      items: [
        {
          childStreamId: 'agent-1',
          executionId: 'agent-1',
          agentName: 'reviewer',
          identity: { kind: 'agent' as const, agent: 'reviewer' },
        },
      ],
    });
    emitRunEvent(bridge, 'parent' as StreamTabId, {
      type: 'child.activity',
      parentStreamId: 'parent',
      items: [],
    });

    const badgeUpdate = progressMessages(
      messages,
      PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
    ).at(-1);
    // The roster keeps its finished child as a full row — a retained entry
    // is exactly the vanished one, stamped with `finishedAt`.
    expect(badgeUpdate).toMatchObject({
      subagents: [
        {
          executionId: 'agent-1',
          agentName: 'reviewer',
          finishedAt: 1_000,
        },
      ],
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
        const config = workflowConfig();
        snapshotFacts(store).setRunConfig(waitingStream, config, 'abc123');
        snapshotFacts(store).setRunConfig(crashedStream, config, 'def456');
      },
      detectWaitingStreams,
    });

    expect(detectWaitingStreams).toHaveBeenCalledOnce();
    expect(bridgeStatus(bridge).get(waitingStream)).toBe(STREAM_PHASE.WAITING);
    expect(bridgeStatus(bridge).get(crashedStream)).toBe(STREAM_PHASE.FAILED);
    expectLastLogGroupEnd(
      bridge.streamLogs,
      waitingStream,
      RUN_OUTCOME.CANCELLED,
    );
    expectLastLogGroupEnd(bridge.streamLogs, crashedStream, RUN_OUTCOME.FAILED);
  });

  it('starts a fresh process session on restart and repairs waiting and orphaned streams', async () => {
    const waitingStream = 'restart-waiting' as StreamTabId;
    const orphanedStream = 'restart-orphaned' as StreamTabId;
    const executionId = 'ec0e57a7' as ExecutionId;
    const kvStoreBacking = new Map<string, unknown>();
    const first = await createBridge([], { kvStoreBacking });
    const firstSession = bridgeSession(first);
    const firstSnapshots = bridgeSnapshots(first);
    const runConfig = workflowConfig();

    appendRunningGroup(
      first.streamLogs as unknown as StreamLogStore,
      waitingStream,
    );
    appendRunningGroup(
      first.streamLogs as unknown as StreamLogStore,
      orphanedStream,
    );
    snapshotFacts(firstSnapshots).setRunConfig(
      waitingStream,
      runConfig,
      executionId,
    );
    const { getExecutionStore } = await import('@agent/storage');
    await getExecutionStore(executionId).writeRunRecord(runConfig);
    await firstSnapshots.flush();
    await firstSession.flushArtifacts();
    first.dispose();
    firstSession.dispose();

    const detectWaitingStreams = vi.fn(async () => new Set([waitingStream]));
    const second = await createBridge([], {
      kvStoreBacking,
      detectWaitingStreams,
    });
    const secondSession = bridgeSession(second);

    expect(secondSession).not.toBe(firstSession);
    expect(secondSession.executions).not.toBe(firstSession.executions);
    expect(detectWaitingStreams).toHaveBeenCalledWith(
      new Map([[waitingStream, executionId]]),
    );
    expect(bridgeStatus(second).get(waitingStream)).toBe(STREAM_PHASE.WAITING);
    expect(second.streamLogs.get(waitingStream)).toBeUndefined();
    expect(second.streamLogs.get(orphanedStream)).toBeUndefined();

    await Promise.all([
      second.streamLogs.ensureLoaded(waitingStream),
      second.streamLogs.ensureLoaded(orphanedStream),
    ]);
    expectLastLogGroupEnd(
      second.streamLogs,
      waitingStream,
      RUN_OUTCOME.CANCELLED,
    );
    expectLastLogGroupEnd(
      second.streamLogs,
      orphanedStream,
      RUN_OUTCOME.FAILED,
    );
    await getExecutionStore(executionId).clear();
  });

  it('repairs a crashed unfinished canonical log without legacy metadata', async () => {
    const streamId = 'unfinished-stream' as StreamTabId;
    const bridge = await createBridge([], {
      canonicalStreamIds: [streamId],
      configureTranscripts: (store) => appendRunningGroup(store, streamId),
    });

    expect(bridge.streamLogs.getUnfinishedStreamIds()).toEqual([]);
    expectLastLogGroupEnd(bridge.streamLogs, streamId, RUN_OUTCOME.FAILED);
    expect(bridgeStatus(bridge).get(streamId)).toBe(STREAM_PHASE.FAILED);
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
        snapshotFacts(store).setRunConfig(
          mappedStream,
          workflowConfig(),
          executionId,
        );
      },
      detectWaitingStreams,
    });

    expect(detectWaitingStreams).toHaveBeenCalledOnce();
    expect(bridge.streamLogs.getUnfinishedStreamIds()).toEqual([mappedStream]);
    expectLastLogGroupEnd(
      bridge.streamLogs,
      unmappedStream,
      RUN_OUTCOME.FAILED,
    );
    expect(
      bridge.streamLogs.get(mappedStream)?.getRange(0).at(-1),
    ).not.toMatchObject({ type: STREAM_LOG_ENTRY_TYPES.GROUP_END });
  });

  it('presents a merge failure that occurs before lifecycle startup', async () => {
    const runAgent = vi.fn(
      async (
        _request: unknown,
        _options: Parameters<RunExecutionRequest>[1],
      ) => {
        throw new Error('model setup failed');
      },
    );
    const { showErrorMessage } = await startMergeExecution(runAgent);

    await vi.waitFor(() =>
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Merge failed: model setup failed',
      ),
    );
    expect(runAgent.mock.calls[0]?.[1].suppressErrorNotification).toBe(true);
  });

  it('presents a terminal merge failure exactly once from its result', async () => {
    const mergeExecutionId = 'merge-terminal-failure';
    const mergeStreamId = 'merge-terminal-stream';
    const runAgent = vi.fn(
      async (
        _request: unknown,
        options: Parameters<RunExecutionRequest>[1],
      ) => {
        await options.onRun?.({ executionId: mergeExecutionId });
        options.session.publishRunEvent(mergeStreamId, {
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          executionId: mergeExecutionId,
          streamId: mergeStreamId,
          agentName: 'proofreader',
          category: 'workflow',
          isSubagent: false,
          error: {
            kind: 'unexpected',
            message: 'merge execution failed',
          },
        });
        throw new Error('merge execution failed');
      },
    );
    const { showErrorMessage } = await startMergeExecution(runAgent);

    await vi.waitFor(() =>
      expect(showErrorMessage).toHaveBeenCalledWith('merge execution failed'),
    );
    expect(showErrorMessage).toHaveBeenCalledOnce();
  });

  it('presents a post-result merge failure when the result completed', async () => {
    const mergeExecutionId = 'merge-post-result-failure';
    const mergeStreamId = 'merge-post-result-stream';
    const runAgent = vi.fn(
      async (
        _request: unknown,
        options: Parameters<RunExecutionRequest>[1],
      ) => {
        await options.onRun?.({ executionId: mergeExecutionId });
        options.session.publishRunEvent(mergeStreamId, {
          type: 'result',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: mergeExecutionId,
          streamId: mergeStreamId,
          agentName: 'proofreader',
          category: 'workflow',
          isSubagent: false,
        });
        throw new Error('artifact flush failed');
      },
    );
    const { showErrorMessage } = await startMergeExecution(runAgent);

    await vi.waitFor(() =>
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Merge failed: artifact flush failed',
      ),
    );
    expect(showErrorMessage).toHaveBeenCalledOnce();
  });

  it('does not expose the desktop bridge before transcript opening settles', async () => {
    const messages: unknown[] = [];
    await openTranscriptGatedBridge(messages, {}, async (bridge) => {
      await bridge.completeWebviewReady();

      expect(
        progressMessages(messages, PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS)
          .length,
      ).toBeGreaterThan(0);
    });
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
      expect(snapshots?.getRunMetadata(streamId).executionId).toBe(executionId);
      return new Set<StreamTabId>();
    });

    const bridge = await createBridge([], {
      canonicalStreamIds: [streamId],
      configureProgressSnapshotStore: (store) => {
        snapshots = store;
        snapshotFacts(store).setRunConfig(
          streamId,
          workflowConfig(),
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
        const { AgentExecutionHandle } =
          await import('@agent/runtime/ExecutionHandle');
        session.executions.track(
          new AgentExecutionHandle(
            {
              streamId: 'bash#attachment-order-child' as StreamTabId,
              executionId: 'abcdef' as ExecutionId,
              identity: { kind: 'process', tool: 'bash' },
              category: AgentCategory.ToolUse,
            },
            streamId,
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

  it('preserves queued notices when approval replay closes the attaching presentation', async () => {
    let finishDetection!: (value: Set<StreamTabId>) => void;
    const detectionGate = new Promise<Set<StreamTabId>>((resolve) => {
      finishDetection = resolve;
    });
    const detectWaitingStreams = vi.fn(async () => detectionGate);
    const firstInfo = vi.fn(async () => undefined);
    const bridgeRef: { current?: TestableBridge } = {};

    const bridge = await createBridge([], {
      configureSession: (session) => {
        session.interactions.showInfoMessage('survive approval replay', {
          replayWhenAttached: true,
        });
        void session.interactions.requestPlanApproval?.({
          approvalId: 'close-during-attachment',
          streamId: 'attachment-close-stream' as StreamTabId,
          plan: { objective: 'Close while replaying this approval.' },
          goalEnabled: false,
        });
      },
      deferReady: true,
      detectWaitingStreams,
      showInfoMessage: firstInfo,
      observeRendererMessage: (message) => {
        const progress = message as ProgressMessage;
        if (
          progress.command === PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION &&
          progress.action === 'show'
        ) {
          bridgeRef.current?.dispose();
        }
      },
    });
    bridgeRef.current = bridge;
    await vi.waitFor(() => expect(detectWaitingStreams).toHaveBeenCalled());
    finishDetection(new Set());
    await bridge.waitUntilReady();

    const interactions = bridgeInteractions(bridge) as unknown as {
      attachments: unknown[];
    };
    expect(interactions.attachments).toHaveLength(0);
    expect(firstInfo).not.toHaveBeenCalled();

    const { ctor, options: firstBridgeOptions } = bridgeContext(bridge);
    const replacementInfo = vi.fn(async () => undefined);
    const replacement = disposeAfterTest(
      new ctor(() => undefined, {
        ...firstBridgeOptions,
        host: createStubDesktopAgentExecutionHost({
          showInfoMessage: replacementInfo,
        }),
      }),
    );
    await replacement.waitUntilReady();

    expect(replacementInfo).toHaveBeenCalledOnce();
    expect(replacementInfo).toHaveBeenCalledWith('survive approval replay');
    await Promise.resolve();
    expect(replacementInfo).toHaveBeenCalledOnce();
  });

  it('ignores renderer switches to unknown streams', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    bridge.setActiveStream('missing-stream');

    expect(messages).toEqual([]);
  });

  it('revealStream selects the stream (issue #7751 FS6)', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'goal-owning-stream');
    await settleProgressEvents();
    messages.length = 0;

    await bridge.revealStream('goal-owning-stream');

    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
    ).toContainEqual({
      activeStream: 'goal-owning-stream',
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
    });
    expect(lastContentSync(messages)).toMatchObject({
      stream: 'goal-owning-stream',
    });
  });

  it('revealStream posts nothing when the stream is unknown', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    // Reported so the settings panel can say the run is gone instead of
    // leaving the click with no visible effect.
    await expect(bridge.revealStream('missing-goal-stream')).resolves.toBe(
      'missing',
    );
    expect(messages).toEqual([]);
  });

  it('revealStream selects a canonical stream with no live session facts yet (issue #7851)', async () => {
    const messages: unknown[] = [];
    const streamId = 'persisted-tool-use-stream' as StreamTabId;
    const executionId = 'f00d123' as ExecutionId;
    const runConfig = AgentConfigSchema.parse({
      ...SEARCH_TOOL_USE_AGENT_CONFIG,
      toolConfig: DEFAULT_TOOL_CONFIG,
    });
    const bridge = await createBridge(messages, {
      canonicalStreamIds: [streamId],
      kvStoreBacking: new Map<string, unknown>([
        [`executions/${executionId}/config`, runConfig],
      ]),
      configureProgressSnapshotStore: (store) => {
        snapshotFacts(store).setRunConfig(streamId, runConfig, executionId);
      },
    });

    messages.length = 0;

    await bridge.revealStream(streamId);

    expect(lastContentSync(messages)).toMatchObject({ stream: streamId });
  });

  it('reveals a goal-owned stream after persistent opening completes', async () => {
    const messages: unknown[] = [];
    await openTranscriptGatedBridge(
      messages,
      {
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
      },
      async (bridge) => {
        await bridge.revealStream('goal-owning-stream');

        expect(
          progressMessages(messages, PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
        ).toContainEqual({
          activeStream: 'goal-owning-stream',
          command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        });
      },
    );
  });

  it('emits delete-stream cleanup and flushes fallback active stream logs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'first');
    activateStream(bridge, 'second');
    await bridge.streamLogs.ensureLoaded('first');
    const firstWriter = bridge.streamLogs.acquireWriter('first', 'test-writer');
    firstWriter.append({
      id: 'first-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_500,
      text: 'first stream log',
    });
    firstWriter.close();
    await settleProgressEvents();
    messages.length = 0;

    await deleteStreamViaInbound(bridge, 'second');
    await settleProgressEvents();

    await vi.waitFor(() =>
      expect(
        messages.map((message) => (message as ProgressMessage).command),
      ).toEqual([
        PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      ]),
    );
    expect(messages[0]).toMatchObject({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: 'second',
    });
    expect(messages[1]).toMatchObject({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: 'first',
    });
    expect(messages[2]).toMatchObject({
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      action: 'render',
      stream: 'first',
      category: AgentCategory.Workflow,
      runUsage: {},
      outputs: { files: {}, missing: {}, compileFailures: {} },
      activeState: {
        conversationProgress: { toolCallCount: 0 },
        stage: null,
        badges: {
          subagents: [],
        },
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
    activateStream(bridge, stream);
    await settleProgressEvents();
    messages.length = 0;

    await deleteStreamViaInbound(bridge, stream);
    await settleProgressEvents();

    expect(lastStreamSync(messages)).toMatchObject({ activeStream: stream });
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

    activateStream(bridge, 'plan-delete-stream');

    const result = bridgeInteractions(bridge).requestPlanApproval?.({
      approvalId: 'plan-cancel-on-delete',
      streamId: 'plan-delete-stream' as StreamTabId,
      plan: { objective: 'Check cancellation on stream delete.' },
      goalEnabled: false,
    });

    await waitForShownPermission(messages, {
      kind: PERMISSION_KIND.PLAN_APPROVAL,
      data: { approvalId: 'plan-cancel-on-delete' },
    });

    await deleteStreamViaInbound(bridge, 'plan-delete-stream' as StreamTabId);

    // This promise must settle through releaseStreamResources, which owns
    // stream-scoped interaction cleanup.
    await expect(result).resolves.toEqual(STREAM_RELEASED_REJECTION);
    expectPermissionResolved(
      messages,
      PERMISSION_KIND.PLAN_APPROVAL,
      'plan-cancel-on-delete',
    );
  });

  it('does not resume a stream deleted in this desktop session', async () => {
    const retrieveSessionResumeData = vi.fn(async () =>
      searchToolUseResumeData(),
    );
    const bridge = await createBridge([], {
      canonicalStreamIds: ['stream-1'],
      retrieveSessionResumeData,
    });

    emitSearchRunConfig(bridge);

    await deleteStreamViaInbound(bridge, 'stream-1');
    emitSearchRunConfig(bridge);
    await expect(tryResumeStream('stream-1')).resolves.toBe(false);
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('forgets desktop goal records when deleting a stream', async () => {
    const stream = 'goal-stream' as StreamTabId;
    const bridge = await createBridge([]);
    const { GoalStore: bridgeGoalStore } = await import('@tools/goal');
    await bridgeGoalStore.forget(stream);
    await bridgeGoalStore.start(stream, 'finish the cleanup');

    try {
      activateStream(bridge, stream);

      await deleteStreamViaInbound(bridge, stream);

      expect(bridgeGoalStore.getForStream(stream)).toBeNull();
    } finally {
      await bridgeGoalStore.forget(stream);
    }
  });

  it('preserves renderer stream switches that land during active stream deletion', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'first');
    activateStream(bridge, 'second');
    activateStream(bridge, 'third');
    await settleProgressEvents();
    bridge.setActiveStream('second');
    messages.length = 0;

    const deletePromise = deleteStreamViaInbound(bridge, 'second');
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
    expect(lastContentSync(messages)).toMatchObject({ stream: 'third' });
  });

  it('falls back if a deleted stream is reactivated during deletion', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'first');
    activateStream(bridge, 'second');
    await settleProgressEvents();
    bridge.setActiveStream('first');
    messages.length = 0;

    const deletePromise = deleteStreamViaInbound(bridge, 'second');
    activateStream(bridge, 'second');
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
    expect(lastContentSync(messages)).toMatchObject({ stream: 'first' });
  });

  it('emits delete-all cleanup before syncing an empty stream list', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);
    const cancel = vi.spyOn(bridgeSession(bridge).interactions, 'cancel');

    activateStream(bridge, 'active');
    await settleProgressEvents();
    messages.length = 0;

    await deleteAllStreamsViaInbound(bridge);

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
    // The retained stream must have resolved a category (via run.config) or
    // the pending tab renders no synced content at all.
    emitRunConfigFact(bridge, {
      streamId: retainedStream,
      executionId: 'feed01' as ExecutionId,
      config: workflowConfig(),
    });
    bridge.setActiveStream(deletedStream);
    messages.length = 0;

    await deleteAllStreamsViaInbound(bridge);
    await settleProgressEvents();

    expect(lastStreamSync(messages)).toMatchObject({ activeStream: '' });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: retainedStream,
    });
    expect(
      progressMessages(messages, PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
    ).toContainEqual(expect.objectContaining({ stream: retainedStream }));
  });

  it('cancels a pending bash approval instead of hanging when all streams are deleted', async () => {
    const messages: unknown[] = [];
    const bridge = await createBridge(messages);

    activateStream(bridge, 'bash-delete-all-stream');

    const result = bridgeInteractions(bridge).requestBashApproval?.({
      command: 'echo hi',
      streamId: 'bash-delete-all-stream' as StreamTabId,
    });

    await waitForShownPermission(messages, { kind: PERMISSION_KIND.BASH });

    await deleteAllStreamsViaInbound(bridge);

    // This promise must settle through releaseStreamResources, which owns
    // stream-scoped interaction cleanup.
    await expect(result).resolves.toEqual(STREAM_RELEASED_REJECTION);
  });

  it('resumes workflow streams from persisted meta', async () => {
    const executionId = 'abc123';
    const runConfig = workflowConfig();
    const retrieveSessionResumeData = stubWorkflowResumeData(
      runConfig,
      executionId,
    );
    const runAgent = vi.fn(async () => {});
    // One mocked KV serves both stores: the stream sidecar reads only the
    // executionId FK from `meta`, while the execution store reads
    // timestamp/identity/description from the same blob and the run config
    // from `config` — identity and config live in `executions/{id}/`, never
    // as a sidecar copy.
    const kvRead = vi.fn(async (key: string) => {
      if (key === 'meta') {
        return {
          executionId,
          timestamp: '2026-07-10T00:00:00.000Z',
          identity: { kind: 'agent', agent: runConfig.agent },
          description: 'Persisted workflow',
        };
      }
      if (key === 'config') return runConfig;
      return undefined;
    });
    const bridge = await createBridge([], {
      kvRead,
      retrieveSessionResumeData,
      runAgent,
      canonicalStreamIds: ['stream-1'],
      // The sidecar existence probe (listKeys) consults the backing map;
      // reads themselves stay answered by kvRead above, as in production
      // where the listing and the reads see the same directory.
      kvStoreBacking: new Map<string, unknown>([
        ['streamData/stream-1/meta', {}],
      ]),
    });

    try {
      await expect(tryResumeStream('stream-1')).resolves.toBe(true);
      expect(kvRead).toHaveBeenCalledWith('meta');
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        executionId,
        expect.objectContaining(runConfig),
        { parentStreamId: undefined },
      );
      expectWorkflowResume(runAgent, runConfig, executionId);
    } finally {
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('runs a fresh stream through the shared workflow-actions controller', async () => {
    const runConfig = workflowConfig();
    const runAgent = vi.fn(async () => {});
    const bridge = await createBridge([], { runAgent });

    // Rerun is gated on a resolved native agent identity.
    emitRunEvent(bridge, 'stream-new' as StreamTabId, {
      type: 'run.start',
      streamId: 'stream-new' as StreamTabId,
      executionId: 'exec-new' as ExecutionId,
      identity: { kind: 'agent', agent: runConfig.agent },
    });
    emitRunConfigFact(bridge, {
      streamId: 'stream-new',
      executionId: 'exec-new',
      config: runConfig,
    });

    const runNew = assertSupported(
      bridge.progressViewInboundHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW],
    );
    await runNew({
      command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
      stream: 'stream-new',
    });

    // Fresh run: the existing execution id is dropped (no resume reuse).
    expect(runAgent).toHaveBeenCalledWith(
      { config: expect.objectContaining(runConfig) },
      expect.objectContaining({
        session: expect.objectContaining({
          interactions: expect.objectContaining({ emit: expect.any(Function) }),
        }),
      }),
    );
  });

  it('resumes canonical streams using sidecar execution ids', async () => {
    const executionId = 'abc123';
    const streamId = 'stream-1' as StreamTabId;
    const runConfig = workflowConfig();
    const retrieveSessionResumeData = stubWorkflowResumeData(
      runConfig,
      executionId,
    );
    const runAgent = vi.fn(async () => {});
    let snapshots: ProgressSnapshotStore | undefined;
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      runAgent,
      canonicalStreamIds: [streamId],
      kvStoreBacking: new Map<string, unknown>([
        [`executions/${executionId}/config`, runConfig],
      ]),
      configureProgressSnapshotStore: (store) => {
        snapshots = store;
        snapshotFacts(store).setRunConfig(streamId, runConfig, executionId);
        snapshotFacts(store).setDescription(streamId, 'Persisted workflow');
      },
    });

    try {
      expect(snapshots?.getRunMetadata(streamId)).toMatchObject({
        config: runConfig,
        executionId,
      });
      await expect(tryResumeStream(streamId)).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        streamId,
        executionId,
        expect.objectContaining(runConfig),
        { parentStreamId: undefined },
      );
      expectWorkflowResume(runAgent, runConfig, executionId);
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
    let pendingAtAttachment: readonly { text: string; origin?: string }[] = [];
    const resumeToolUseFromResumeData = vi.fn(async (...args: unknown[]) => {
      const options = args[1] as {
        onFollowUpConsumed?: () => void;
        takePendingFollowUps(): readonly { text: string; origin?: string }[];
      };
      pendingAtAttachment = options.takePendingFollowUps();
      options.onFollowUpConsumed?.();
    });
    const messages: unknown[] = [];
    const bridge = await createBridge(messages, {
      retrieveSessionResumeData,
      resumeToolUseFromResumeData,
      canonicalStreamIds: ['stream-1'],
    });
    try {
      emitSearchRunConfig(bridge);
      emitSessionFact(bridge, 'setParentStream', {
        childStreamId: 'stream-1',
        parentStreamId,
      });
      seedBridgeFollowUp(bridge, 'stream-1' as StreamTabId, 'queued follow-up');

      await expect(tryResumeStream('stream-1')).resolves.toBe(true);
      expect(retrieveSessionResumeData).toHaveBeenCalledWith(
        'stream-1',
        'ec1001',
        SEARCH_TOOL_USE_AGENT_CONFIG,
        { parentStreamId },
      );
      expect(resumeToolUseFromResumeData).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'ec1001',
          streamId: 'stream-1',
          parentStreamId,
        }),
        expect.objectContaining({
          takePendingFollowUps: expect.any(Function),
        }),
      );
      const [, resumeOptions] = resumeToolUseFromResumeData.mock
        .calls[0] as unknown as [
        unknown,
        {
          drainedFollowUps?: readonly { text: string; origin?: string }[];
        },
      ];
      // The drained batch travels via the direct drainedFollowUps handoff (a
      // subagent's WAITING cursor never reads the stream queue). The attachment
      // drain closes the only race before later input can target the live flow.
      expect(resumeOptions.drainedFollowUps?.map((item) => item.text)).toEqual([
        'queued follow-up',
      ]);
      expect(pendingAtAttachment).toEqual([]);
    } finally {
      bridgeFollowUps(bridge).terminalize('stream-1');
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('keeps queued follow-ups when tool-use resume fails', async () => {
    const retrieveSessionResumeData = vi.fn(async () =>
      searchToolUseResumeData(),
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
      emitSearchRunConfig(bridge);
      seedBridgeFollowUp(bridge, 'stream-1' as StreamTabId, 'queued follow-up');

      await expect(tryResumeStream('stream-1')).resolves.toBe(false);
      expect(bridgeFollowUps(bridge).getAll('stream-1')).toEqual([
        'queued follow-up',
      ]);
      expect(bridgeStatus(bridge).get('stream-1')).toBe(STREAM_STATUS.WAITING);
    } finally {
      bridgeFollowUps(bridge).terminalize('stream-1');
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
      seedStreamStatusForTest(bridgeStatus(bridge), 'stream-1', {
        phase: STREAM_PHASE.RUNNING,
      });

      await expect(tryResumeStream('stream-1')).resolves.toBe(false);
      expect(retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      bridgeStatus(bridge).clearStream('stream-1');
    }
  });

  it('does not launch duplicate concurrent resume attempts', async () => {
    const retrieveGate = createDeferred();
    const retrieveStarted = createDeferred();
    const retrieveSessionResumeData = vi.fn(async () => {
      retrieveStarted.resolve();
      await retrieveGate.promise;
      return searchToolUseResumeData();
    });
    const bridge = await createBridge([], {
      retrieveSessionResumeData,
      canonicalStreamIds: ['stream-1'],
    });

    try {
      emitSearchRunConfig(bridge);

      const firstResume = tryResumeStream('stream-1');
      await retrieveStarted.promise;
      await expect(tryResumeStream('stream-1')).resolves.toBe(false);
      retrieveGate.resolve();
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
    // The port emits its own ensure-view/activation events; settle them
    // before snapshotting messages.
    await settleProgressEvents();
    messages.length = 0;

    const handleProposal = assertSupported(
      bridge.progressViewInboundHandlers[
        PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION
      ],
    );
    await handleProposal({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'setup',
    });

    await expect(result).resolves.toEqual({ action: 'setup' });
    expect(messages).toEqual([
      { command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER },
      expect.objectContaining({
        command: COMMON_COMMANDS.STATE_RESTORE,
        state: expect.objectContaining({
          sessionType: 'workflow',
          model: 'gemini31p',
          instruction: { workflow: 'Check this draft.', toolUse: '' },
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

    emitRunEvent(bridge, 'stream-1' as StreamTabId, {
      type: 'run.start',
      streamId: 'stream-1' as StreamTabId,
      executionId: 'ec1002' as ExecutionId,
      identity: { kind: 'agent', agent: 'search' },
    });
    emitRunConfigFact(bridge, {
      streamId: 'stream-1',
      executionId: 'ec1002' as ExecutionId,
      config: SEARCH_TOOL_USE_AGENT_CONFIG,
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

    expect(messages).toEqual([
      { command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER },
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
    // so restoreRunConfig() returns false and the handler must surface it
    // instead of silently doing nothing (unlike the extension's
    // texra.restoreState, which shows RESTORE_MALFORMED_MESSAGE).
    emitRunEvent(bridge, 'stream-1' as StreamTabId, {
      type: 'run.start',
      streamId: 'stream-1' as StreamTabId,
      executionId: 'ec1003' as ExecutionId,
      identity: { kind: 'agent', agent: 'search' },
    });
    emitRunConfigFact(bridge, {
      streamId: 'stream-1',
      executionId: 'ec1003' as ExecutionId,
      config: {
        ...SEARCH_TOOL_USE_AGENT_CONFIG,
        inputFiles: 12345,
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

    const shutdownWriter = bridge.streamLogs.acquireWriter(
      streamId,
      'test-writer',
    );
    shutdownWriter.append({
      id: 'shutdown-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      text: 'persist me before quit',
    });
    shutdownWriter.close();

    await bridgeSession(bridge).flushArtifacts();
    bridge.streamLogs.requestEviction(streamId);
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
    }: {
      streamId: StreamTabId;
      executionId: ExecutionId;
      agentName?: string;
      category?: AgentCategory;
      messages?: unknown[];
      detectWaitingStreams?: ReturnType<typeof vi.fn>;
    }) {
      const {
        bridgeModule,
        createProgressSnapshotStore,
        createSession,
        openTranscripts,
        processResumeOwner,
      } = await loadBridgeModule({ detectWaitingStreams });
      const { AgentExecutionHandle } =
        await import('@agent/runtime/ExecutionHandle');
      const { getExecutionStore } = await import('@agent/storage');
      const transcripts = await openTranscripts();
      transcripts.ensureStream(streamId);
      await transcripts.flush();
      const progressSnapshotStore = createProgressSnapshotStore();
      const processSession = createSession(transcripts, progressSnapshotStore);
      const { attachTerminalResultToast } =
        await import('@agent/runtime/terminalResultToast');
      const detachTerminalResultToast = attachTerminalResultToast(
        processSession,
        processSession.interactions,
        { replayWhenAttached: true },
      );
      const { initializeDesktopProcessStores } =
        await import('@desktop/main/desktopProcessStores');
      const processStores =
        await initializeDesktopProcessStores(processSession);
      await processSession.waitUntilReady();
      const { stores: sessionStores } = processStores;
      const disposeResumeHandler = processResumeOwner.attach({
        session: processSession,
      });
      snapshotFacts(progressSnapshotStore).setRunConfig(
        streamId,
        AgentConfigSchema.parse({
          ...workflowConfig(),
          agent: agentName,
          agentCategory: category,
        }),
        executionId,
      );
      const errorsA: string[] = [];
      const infosA: string[] = [];
      const diffPathsA: Array<{ original: string; proposed: string }> = [];
      const bridgeAOptions: DesktopProgressBridgeOptions = {
        session: processSession,
        sessionStores,
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
      };
      const bridgeA = new bridgeModule.DesktopProgressBridge((message) => {
        messages.push(message);
      }, bridgeAOptions) as unknown as TestableBridge;
      bridgeContexts.set(bridgeA, {
        session: processSession,
        snapshots: progressSnapshotStore,
        ctor: bridgeModule.DesktopProgressBridge,
        options: bridgeAOptions,
      });
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
        const nextExecutionId = options.executionId ?? executionId;
        const nextHandle = new AgentExecutionHandle(
          {
            streamId: options.childStreamId ?? streamId,
            executionId: nextExecutionId,
            identity: { kind: 'agent', agent: options.agentName ?? agentName },
            category: options.category ?? category,
          },
          options.parentStreamId ?? streamId,
          nextTrace as unknown as ConstructorParameters<
            typeof AgentExecutionHandle
          >[2],
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

      const reopen = async (
        reopenedMessages: unknown[] = [],
        observeRendererMessage?: (message: unknown) => void,
      ) => {
        close();
        const errorsB: string[] = [];
        const infosB: string[] = [];
        const bridgeBOptions: DesktopProgressBridgeOptions = {
          session: processSession,
          sessionStores,
          host: createStubDesktopAgentExecutionHost({
            showErrorMessage: async (message) => {
              errorsB.push(message);
            },
            showInfoMessage: async (message) => {
              infosB.push(message);
            },
          }),
        };
        const bridgeB = new bridgeModule.DesktopProgressBridge((message) => {
          reopenedMessages.push(message);
          observeRendererMessage?.(message);
        }, bridgeBOptions) as unknown as TestableBridge;
        bridgeContexts.set(bridgeB, {
          session: processSession,
          snapshots: progressSnapshotStore,
          ctor: bridgeModule.DesktopProgressBridge,
          options: bridgeBOptions,
        });
        presentationBridges.add(bridgeB);
        await bridgeB.waitUntilReady();
        return { bridgeB, errorsB, infosB, progressSnapshotStore };
      };

      disposeAfterTest({
        dispose: () => {
          for (const bridge of presentationBridges) bridge.dispose();
          disposeResumeHandler();
          detachTerminalResultToast();
          processStores.dispose();
          processSession.dispose();
        },
      });

      return {
        bridgeA,
        close,
        createHandle,
        errorsA,
        infosA,
        diffPathsA,
        getExecutionStore,
        handle,
        processSession,
        progressSnapshotStore,
        sessionStores,
        reopen,
        trace,
      };
    }

    it('keeps a live transcript append made before replacement attaches', async () => {
      const streamId = 'process-stream-live-reopen' as StreamTabId;
      const childStreamId = 'process-child-live-reopen' as StreamTabId;
      const executionId = 'ec00dc' as ExecutionId;
      const childExecutionId = 'ec00db' as ExecutionId;
      const owner = await createProcessOwner({
        streamId,
        executionId,
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
      appendTranscriptEntry(owner.processSession.transcripts, streamId, {
        id: 'during-reopen',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 2_500,
        text: 'Appended while replacement presentation loaded.',
      });
      owner.processSession.transcripts.ensureStream(childStreamId);
      owner.processSession.publishRunEvent(childStreamId, {
        type: 'run.start',
        streamId: childStreamId,
        executionId: childExecutionId,
        identity: { kind: 'agent', agent: 'search' },
      });
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
      const { bridgeB } = await owner.reopen(messagesB);

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
          owner.progressSnapshotStore.getRunMetadata(childStreamId).config
            ?.agent,
        ).toBe('search');
        expect(
          owner.progressSnapshotStore.getParentStreamId(childStreamId),
        ).toBe(streamId);
        expect(lastStreamSync(messagesB)).toMatchObject({
          streams: expect.arrayContaining([
            expect.objectContaining({
              name: childStreamId,
              label: 'search',
              identity: { kind: 'agent', agent: 'search' },
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
        await waitForShownPermission(messagesB, {
          kind: PERMISSION_KIND.PLAN_APPROVAL,
          data: { approvalId: 'plan-rebound' },
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

    it('routes a retained session event only to the current presentation', async () => {
      const streamId = 'process-runtime-host' as StreamTabId;
      const executionId = 'ec00de' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB, errorsB } = await owner.reopen();

      try {
        owner.processSession.interactions.emit('requestShowError', {
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
        oldRequestId =
          shownPermissionRequestId(messagesA, PERMISSION_KIND.TOOL_EDIT) ?? '';
        expect(oldRequestId).not.toBe('');
      });
      const handleOldToolEdit = assertSupported(
        owner.bridgeA.progressViewInboundHandlers[
          PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
        ],
      );
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
          newRequestId =
            shownPermissionRequestId(messagesB, PERMISSION_KIND.TOOL_EDIT) ??
            '';
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
          feedback: 'Not this edit.',
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
      await waitForShownPermission(messagesB, {
        data: { approvalId: 'plan-second-window-close' },
      });

      const staleInteractionsB = bridgeB.hostInteractions;
      bridgeB.dispose();
      const messagesC: unknown[] = [];
      const { bridgeB: bridgeC } = await owner.reopen(messagesC);
      try {
        await bridgeC.waitUntilReady();
        await waitForShownPermission(messagesC, {
          data: { approvalId: 'plan-second-window-close' },
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
      await waitForShownPermission(messagesA, {
        data: { approvalId: 'plan-before-close' },
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
          kind: 'toolEdit',
        });
        expect(
          isApprovalBypassedForStream(streamId, owner.processSession),
        ).toBe(true);
        // Per-kind grant: an edit prompt leaves shell commands gated.
        expect(
          isBashApprovalBypassedForStream(streamId, owner.processSession),
        ).toBe(false);
        expect(
          isApprovalBypassedForStream(streamId, bridgeSession(bridgeB)),
        ).toBe(true);

        for (const approvalId of ['plan-before-close', 'plan-while-closed']) {
          await waitForShownPermission(messagesB, { data: { approvalId } });
        }

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
        await waitForShownPermission(messagesB, {
          data: { approvalId: 'plan-rebound-delete' },
        });

        await deleteStreamViaInbound(bridgeB, streamId);

        await expect(planPromise).resolves.toEqual(STREAM_RELEASED_REJECTION);
        expectPermissionResolved(
          messagesB,
          PERMISSION_KIND.PLAN_APPROVAL,
          'plan-rebound-delete',
        );
      } finally {
        bridgeB.dispose();
      }
    });

    it('makes one headless approval visible when its window reopens', async () => {
      const streamId = 'rebound-headless-approval' as StreamTabId;
      const owner = await createProcessOwner({
        streamId,
        executionId: 'ec00fa' as ExecutionId,
      });
      owner.close();
      const pendingApproval =
        owner.processSession.interactions.requestPlanApproval({
          approvalId: 'plan-requested-while-headless',
          streamId,
          plan: { objective: 'Restore the detached approval stream.' },
          goalEnabled: false,
        });
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        await bridgeB.revealStream(streamId);
        await vi.waitFor(() => {
          const approvalShows = progressMessages(
            messagesB,
            PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          ).filter(
            (message) =>
              message.action === 'show' &&
              message.permission?.data?.approvalId ===
                'plan-requested-while-headless',
          );
          expect(approvalShows).toHaveLength(1);
          expect(lastContentSync(messagesB)).toMatchObject({
            stream: streamId,
          });
        });
        expect(
          bridgeB.hostInteractions.submitPlanDecision(
            'plan-requested-while-headless',
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
      const owner = await createProcessOwner({
        streamId,
        executionId,
      });
      const rootInterrupt = vi.fn();
      owner.handle.attachInterruptHandler({ interrupt: rootInterrupt });

      // Child handles have no canonical startup entry; only the owner knows them.
      const { handle: childHandle } = owner.createHandle({
        executionId: childExecutionId,
        childStreamId,
        agentName: 'searcher',
        category: AgentCategory.ToolUse,
      });
      const childInterrupt = vi.fn();
      childHandle.attachInterruptHandler({ interrupt: childInterrupt });
      owner.close();
      owner.processSession.executions.trackAgentExecution(childHandle, {
        status: STREAM_PHASE.RUNNING,
      });
      expect(
        owner.processSession.executions.getActiveChildren(streamId),
      ).toMatchObject([
        expect.objectContaining({ executionId: childExecutionId }),
      ]);
      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);

      try {
        bridgeB.syncFullView();
        // Both headless children and the child status remain in the one registry.
        expect(
          owner.processSession.executions.getHandle(childExecutionId),
        ).toBe(childHandle);
        expect(owner.processSession.status.get(childStreamId)).toBe(
          STREAM_PHASE.RUNNING,
        );
        expect(lastStreamSync(messagesB)).toMatchObject({
          streamStates: {
            [streamId]: {
              subagents: [
                expect.objectContaining({ executionId: childExecutionId }),
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
        expect(
          owner.processSession.executions.getHandle(childExecutionId),
        ).toBe(freshChildHandle);

        // Stop cascades through root and the current child turn.
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
          owner.processSession.executions.getHandle(childExecutionId),
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
      snapshotFacts(owner.progressSnapshotStore).setDescription(
        childStreamId,
        'Transient bash child',
      );
      seedStreamStatusForTest(owner.processSession.status, childStreamId, {
        phase: STREAM_PHASE.RUNNING,
      });
      const followUpLease = owner.processSession.followUps.claimLive(
        childStreamId,
        'flow',
      )!;
      owner.processSession.followUps
        .queue(followUpLease)
        .enqueue({ text: 'late follow-up' });
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
      await vi.waitFor(() =>
        expect(owner.processSession.transcripts.has(childStreamId)).toBe(false),
      );
      await owner.sessionStores.waitForPendingStreamDeletions();
      expect(owner.processSession.status.get(childStreamId)).toBeUndefined();
      expect(owner.processSession.followUps.getAll(childStreamId)).toEqual([]);
      await expect(pendingApproval).resolves.toEqual(STREAM_RELEASED_REJECTION);
      expect(
        await owner.progressSnapshotStore.listPersistedStreams(),
      ).not.toContain(childStreamId);

      const messagesB: unknown[] = [];
      const { bridgeB } = await owner.reopen(messagesB);
      try {
        bridgeB.syncFullView();
        expect(lastStreamSync(messagesB)).toMatchObject({
          streams: [expect.objectContaining({ name: streamId })],
        });
        expect(
          lastStreamSync(messagesB)?.streams?.map((stream) => stream.name),
        ).not.toContain(childStreamId);
      } finally {
        bridgeB.dispose();
      }
    });

    it('waits for a terminal child lease before headless auto-close deletion', async () => {
      const streamId = 'headless-lease-parent' as StreamTabId;
      const childStreamId = 'bash#headless-lease-child' as StreamTabId;
      const owner = await createProcessOwner({
        streamId,
        executionId: 'ec00f8' as ExecutionId,
      });
      owner.processSession.transcripts.ensureStream(childStreamId);
      owner.close();

      const leaseReleased = createDeferred();
      const waitForRelease = vi
        .spyOn(owner.sessionStores, 'waitForOwnedExecutionRelease')
        .mockReturnValue(leaseReleased.promise);

      try {
        owner.processSession.events.emit({
          scope: 'session',
          event: {
            type: 'removeStream',
            payload: { streamId: childStreamId },
          },
        });

        await vi.waitFor(() =>
          expect(waitForRelease).toHaveBeenCalledWith(childStreamId),
        );
        const pendingDrain = vi.spyOn(
          owner.sessionStores,
          'waitForPendingStreamDeletions',
        );
        let reopened = false;
        const reopening = owner.reopen().then((result) => {
          reopened = true;
          return result;
        });
        await vi.waitFor(() => expect(pendingDrain).toHaveBeenCalled());
        expect(reopened).toBe(false);

        leaseReleased.resolve();
        const { bridgeB } = await reopening;
        try {
          bridgeB.syncFullView();
          expect(owner.processSession.transcripts.has(childStreamId)).toBe(
            false,
          );
        } finally {
          bridgeB.dispose();
        }
      } finally {
        leaseReleased.resolve();
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
      const deletionStarted = createDeferred();
      const deletionGate = createDeferred();
      vi.spyOn(
        owner.progressSnapshotStore,
        'readPersistedExecutionId',
      ).mockImplementationOnce(async () => {
        deletionStarted.resolve();
        await deletionGate.promise;
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
        await deletionStarted.promise;
        const pendingDrain = vi.spyOn(
          owner.sessionStores,
          'waitForPendingStreamDeletions',
        );
        const reopening = owner.reopen();
        await vi.waitFor(() => expect(pendingDrain).toHaveBeenCalled());
        deletionGate.resolve();

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
      const detachResult = owner.processSession.onResult((event) => {
        resultsSeenByB.push(event);
      });

      try {
        expect(owner.processSession.executions.getHandle(executionId)).toBe(
          owner.handle,
        );
        expect(owner.processSession.status.get(streamId)).toBe(
          STREAM_PHASE.RUNNING,
        );

        // Window presentation does not split canonical lifecycle state.
        expect(
          owner.processSession.status.transitionToWaiting(streamId, 'wait'),
        ).toBe(true);
        expect(owner.processSession.status.get(streamId)).toBe(
          STREAM_PHASE.WAITING,
        );
        expect(
          owner.processSession.status.transition(
            streamId,
            STREAM_PHASE.RUNNING,
            'resume',
          ),
        ).toBe(true);
        expect(owner.processSession.status.get(streamId)).toBe(
          STREAM_PHASE.RUNNING,
        );

        // A later turn replaces both handle and trace in the same registry.
        const { handle: freshHandle, trace: freshTrace } = owner.createHandle();
        owner.processSession.executions.track(freshHandle);
        expect(owner.processSession.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
        expect(
          owner.processSession.status.transitionToWaiting(streamId, 'wait'),
        ).toBe(true);
        expect(owner.processSession.status.get(streamId)).toBe(
          STREAM_PHASE.WAITING,
        );

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
            STREAM_TRANSITION_CAUSE.LIFECYCLE,
          ),
        ).toBe(true);
        expect(resultsSeenByB).toContainEqual(resultEvent);
        expect(owner.processSession.status.get(streamId)).toBe(
          STREAM_PHASE.FAILED,
        );
        expect(errorsB).toEqual(['Failure after desktop reopen.']);
        expect(owner.errorsA).toEqual([]);
        owner.processSession.executions.untrack(executionId);
        expect(
          owner.processSession.executions.getHandle(executionId),
        ).toBeUndefined();
      } finally {
        detachResult();
        bridgeB.dispose();
      }
    });

    it('detaches a closed presentation without disposing process executions', async () => {
      const streamId = 'rebound-stream-dispose' as StreamTabId;
      const executionId = 'ec00f5' as ExecutionId;
      const backgroundExecutionId = 'ec00f6' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();

      const { handle: backgroundHandle } = owner.createHandle({
        executionId: backgroundExecutionId,
        childStreamId: 'bash#rebound-stream-dispose' as StreamTabId,
        agentName: 'bash',
        category: AgentCategory.ToolUse,
      });
      owner.processSession.executions.track(backgroundHandle);
      expect(
        owner.processSession.executions.getHandle(backgroundExecutionId),
      ).toBe(backgroundHandle);

      bridgeB.dispose();
      expect(owner.processSession.executions.getHandle(executionId)).toBe(
        owner.handle,
      );
      expect(
        owner.processSession.executions.getHandle(backgroundExecutionId),
      ).toBe(backgroundHandle);

      const { handle: freshHandle } = owner.createHandle();
      owner.processSession.executions.track(freshHandle);
      const { bridgeB: bridgeC } = await owner.reopen();
      try {
        expect(owner.processSession.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
        expect(
          owner.processSession.executions.getHandle(backgroundExecutionId),
        ).toBe(backgroundHandle);
      } finally {
        bridgeC.dispose();
        owner.processSession.executions.untrack(backgroundExecutionId);
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
        owner.processSession.status.transitionToWaiting(streamId, 'wait'),
      ).toBe(true);
      const { bridgeB } = await owner.reopen();

      try {
        expect(owner.processSession.executions.getHandle(executionId)).toBe(
          owner.handle,
        );

        // Resume replaces the canonical handle under the same id.
        const { handle: freshHandle } = owner.createHandle();
        owner.processSession.executions.track(freshHandle);
        expect(
          owner.processSession.status.transition(
            streamId,
            STREAM_PHASE.RUNNING,
            'resume',
          ),
        ).toBe(true);

        // Identity-safe cleanup preserves the fresh handle.
        expect(owner.processSession.executions.getHandle(executionId)).toBe(
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
        expect(owner.processSession.executions.getHandle(executionId)).toBe(
          freshHandle,
        );
      } finally {
        bridgeB.dispose();
      }
    });

    it('publishes canonical status session facts (#8256)', async () => {
      const streamId = 'rebound-stream-7' as StreamTabId;
      const executionId = 'ec00f7' as ExecutionId;
      const owner = await createProcessOwner({ streamId, executionId });
      const { bridgeB } = await owner.reopen();
      const facts: SessionFact[] = [];
      const detachFacts = owner.processSession.events.subscribe(
        (event) => {
          if (event.scope === 'session') facts.push(event.event);
        },
        { scope: 'session' },
      );

      try {
        // A bare process-session transition (no live trace) still reaches the
        // reopened presentation as a session fact.
        expect(
          owner.processSession.status.transitionToWaiting(streamId, 'wait'),
        ).toBe(true);
        expect(owner.processSession.status.get(streamId)).toBe(
          STREAM_PHASE.WAITING,
        );
        expect(facts).toContainEqual(
          expect.objectContaining({
            type: 'status',
            streamId,
            phase: STREAM_PHASE.WAITING,
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
      const detachFacts = owner.processSession.events.subscribe(
        (event) => {
          if (event.scope === 'session') facts.push(event.event);
        },
        { scope: 'session' },
      );

      try {
        owner.processSession.executions.trackAgentExecution(childHandle, {
          status: STREAM_PHASE.RUNNING,
        });
        expect(owner.processSession.status.get(childStreamId)).toBe(
          STREAM_PHASE.RUNNING,
        );

        // Child finalization order (finalizeChildStream): untrack first,
        // terminal stream status second, and no `result` trace event at all.
        owner.processSession.executions.untrack(childExecutionId);
        expect(
          owner.processSession.executions.getHandle(childExecutionId),
        ).toBeUndefined();
        expect(
          owner.processSession.status.transitionToTerminal(
            childStreamId,
            STREAM_PHASE.COMPLETED,
            STREAM_TRANSITION_CAUSE.LIFECYCLE,
          ),
        ).toBe(true);
        expect(owner.processSession.status.get(childStreamId)).toBe(
          STREAM_PHASE.COMPLETED,
        );
        expect(facts).toContainEqual(
          expect.objectContaining({
            type: 'status',
            streamId: childStreamId,
            phase: STREAM_PHASE.COMPLETED,
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
          owner.processSession.status.transitionToWaiting(streamId, 'wait'),
        ).toBe(true);
        owner.processSession.executions.untrack(executionId);
        expect(
          owner.processSession.status.transitionToTerminal(
            streamId,
            STREAM_PHASE.COMPLETED,
            STREAM_TRANSITION_CAUSE.LIFECYCLE,
          ),
        ).toBe(true);
        expect(owner.processSession.status.get(streamId)).toBe(
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
          .writeRunRecord(childConfig);
        const { handle: childHandle } = owner.createHandle({
          executionId: childExecutionId,
          childStreamId,
          agentName: 'searcher',
          category: AgentCategory.ToolUse,
        });
        owner.processSession.publishRunEvent(childStreamId, {
          type: 'run.start',
          streamId: childStreamId,
          executionId: childExecutionId,
          identity: { kind: 'agent', agent: 'searcher' },
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
        appendTranscriptEntry(owner.processSession.transcripts, childStreamId, {
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

        await bridgeB.completeWebviewReady();
        await bridgeB.setActiveStream(childStreamId);
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
        expect(lastStreamSync(messagesB)).toMatchObject({
          streams: expect.arrayContaining([
            expect.objectContaining({
              name: childStreamId,
              label: 'searcher',
              identity: { kind: 'agent', agent: 'searcher' },
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
            category: AgentCategory.ToolUse,
            runUsage: {
              [childExecutionId]: expect.objectContaining({
                inputTokens: 11,
                outputTokens: 7,
                cost: 0.125,
              }),
            },
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
