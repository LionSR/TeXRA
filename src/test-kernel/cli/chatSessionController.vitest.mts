// Unit tests for the chat-session controller's state transitions.
// Does not require actual agent execution — the controller's orchestration
// methods (startRootRun, resume) touch real agent runtime infrastructure,
// so these tests focus on the pure predicate delegation, the factory
// contract, and the stop/idle state mutations that are safe to verify
// without a full agent harness.

import PQueue from 'p-queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopAgentStream: vi.fn(),
  workspaceGet: vi.fn(),
  getExecutionStore: vi.fn(),
  setCliHelperModel: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  runtimeHostClose: vi.fn(),
  defaultSession: vi.fn(),
  streamIsActiveOrResuming: vi.fn(),
  detachHostInteractions: vi.fn(),
  attachTerminalResultToast: vi.fn(),
  attachTuiRunFactSubscription: vi.fn(),
  createTuiHostInteractions: vi.fn(),
  resolveAndResumeStream: vi.fn(),
  isResumeInFlight: vi.fn(),
  resumeQueuedToolUseSnapshot: vi.fn(),
  projectStreamTranscript: vi.fn(),
  notify: vi.fn(),
  appendLocalAssistantTranscript: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
  clearLocalTranscript: vi.fn(),
  moveLocalTranscriptToStream: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: mocks.getExecutionStore,
  registerExecution: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@agent/runtime/executionRegistry', () => ({
  SharedExecutionRegistry: {
    stopAgentStream: mocks.stopAgentStream,
  },
}));

vi.mock('@agent/runtime/resolveAndResumeStream', () => ({
  resolveAndResumeStream: mocks.resolveAndResumeStream,
  isResumeInFlight: mocks.isResumeInFlight,
}));

vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseSnapshot: mocks.resumeQueuedToolUseSnapshot,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  defaultSession: mocks.defaultSession,
}));

vi.mock('@agent/runtime/terminalResultToast', () => ({
  attachTerminalResultToast: mocks.attachTerminalResultToast,
}));

vi.mock('@platform/platform', () => ({
  tryPlatform: () => ({
    workspaceState: {
      get: mocks.workspaceGet,
    },
  }),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  setCliHelperModel: mocks.setCliHelperModel,
}));

vi.mock('@cli/runtime/runtimeHost', () => ({
  createCliRuntimeHost: mocks.createCliRuntimeHost,
}));

vi.mock('@cli/chat/tui/state/subscribeApprovals', () => ({
  createTuiHostInteractions: mocks.createTuiHostInteractions,
}));

vi.mock('@cli/chat/tui/state/subscribeRuntimeHost', () => ({
  attachTuiRunFactSubscription: mocks.attachTuiRunFactSubscription,
}));

vi.mock('@cli/chat/tui/state/transcriptProjection', () => ({
  projectStreamTranscript: mocks.projectStreamTranscript,
}));

vi.mock('@cli/chat/tui/state/transcript', () => ({
  appendLocalAssistantTranscript: mocks.appendLocalAssistantTranscript,
  appendLocalErrorTranscript: mocks.appendLocalErrorTranscript,
  appendLocalUserTranscript: mocks.appendLocalUserTranscript,
  clearLocalTranscript: mocks.clearLocalTranscript,
  moveLocalTranscriptToStream: mocks.moveLocalTranscriptToStream,
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: mocks.notify,
}));

import { StreamSnapshotStore } from '@transcript';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ResumeStreamPorts } from '@agent/runtime/resolveAndResumeStream';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import type { StreamTabId } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<TuiSession> = {}): TuiSession {
  return {
    streamId: undefined,
    executionId: undefined,
    runtimeHost: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
    ...overrides,
  };
}

function makeSessionContext(): CliContext {
  return {
    cwd: '/tmp/test',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    quietLogs: true,
    helperModel: 'test-model',
    commandName: 'chat',
    apiMode: 'included',
  } as CliContext;
}

function makeInit(
  overrides: Partial<ChatSessionControllerInit> = {},
): ChatSessionControllerInit {
  return {
    session: makeSession(),
    getSessionContext: () => makeSessionContext(),
    disposers: [],
    followUpQueue: new PQueue({ concurrency: 1 }),
    snapshotStore: new StreamSnapshotStore(),
    ...overrides,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeResumeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent: 'demo-agent',
    model: 'demo-model',
    agentCategory: 'toolUse',
    ...overrides,
  } as AgentConfig;
}

function makeResumeSnapshotStore(options: {
  readonly preload?: () => Promise<void>;
  readonly executionId?: string | undefined;
  readonly persistedExecutionId?: string | undefined;
  readonly config?: AgentConfig | undefined;
  readonly parentStreamId?: StreamTabId | undefined;
}): StreamSnapshotStore {
  return {
    preload: vi.fn(options.preload ?? (async () => undefined)),
    getExecutionId: vi.fn(() => options.executionId),
    readPersistedExecutionId: vi.fn(async () => options.persistedExecutionId),
    getRunConfig: vi.fn(() => options.config),
    getParentStreamId: vi.fn(() => options.parentStreamId),
  } as unknown as StreamSnapshotStore;
}

// ---------------------------------------------------------------------------
// Predicate: chatTuiCanStartRootRun
// ---------------------------------------------------------------------------

describe('chatTuiCanStartRootRun', () => {
  it('allows a new root run when no run has ever been started', () => {
    expect(chatTuiCanStartRootRun(makeSession())).toBe(true);
  });

  it('allows a new root run after a prior run has completed', () => {
    expect(
      chatTuiCanStartRootRun(
        makeSession({
          runPromise: Promise.resolve(),
          runCompleted: true,
        }),
      ),
    ).toBe(true);
  });

  it('disallows a new root run while a run is pending', () => {
    expect(
      chatTuiCanStartRootRun(
        makeSession({
          runPromise: new Promise(() => {}), // never settles
          runCompleted: false,
        }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory: createChatSessionController
// ---------------------------------------------------------------------------

describe('createChatSessionController', () => {
  beforeEach(() => {
    mocks.stopAgentStream.mockReset();
    mocks.workspaceGet.mockReset();
    mocks.workspaceGet.mockReturnValue(false);
    mocks.getExecutionStore.mockReset();
    mocks.setCliHelperModel.mockReset();
    mocks.setCliHelperModel.mockResolvedValue(undefined);
    mocks.createCliRuntimeHost.mockReset();
    mocks.runtimeHostClose.mockReset();
    mocks.runtimeHostClose.mockResolvedValue(undefined);
    mocks.createCliRuntimeHost.mockReturnValue({
      close: mocks.runtimeHostClose,
      emit: vi.fn(),
    });
    mocks.defaultSession.mockReset();
    mocks.streamIsActiveOrResuming.mockReset();
    mocks.streamIsActiveOrResuming.mockReturnValue(false);
    mocks.detachHostInteractions.mockReset();
    mocks.attachTerminalResultToast.mockReset();
    mocks.attachTerminalResultToast.mockReturnValue(vi.fn());
    mocks.attachTuiRunFactSubscription.mockReset();
    mocks.attachTuiRunFactSubscription.mockReturnValue(vi.fn());
    mocks.createTuiHostInteractions.mockReset();
    mocks.createTuiHostInteractions.mockReturnValue({});
    mocks.defaultSession.mockReturnValue({
      useHostInteractions: vi.fn(() => mocks.detachHostInteractions),
      interactions: {},
      events: {},
      status: { isActiveOrResuming: mocks.streamIsActiveOrResuming },
    });
    mocks.resolveAndResumeStream.mockReset();
    mocks.resolveAndResumeStream.mockResolvedValue(true);
    mocks.isResumeInFlight.mockReset();
    mocks.isResumeInFlight.mockReturnValue(false);
    mocks.resumeQueuedToolUseSnapshot.mockReset();
    mocks.resumeQueuedToolUseSnapshot.mockResolvedValue(true);
    mocks.projectStreamTranscript.mockReset();
    mocks.notify.mockReset();
    mocks.appendLocalAssistantTranscript.mockReset();
    mocks.appendLocalErrorTranscript.mockReset();
    mocks.appendLocalUserTranscript.mockReset();
    mocks.clearLocalTranscript.mockReset();
    mocks.moveLocalTranscriptToStream.mockReset();
  });

  it('returns an object satisfying the ChatSessionController interface', () => {
    const ctrl = createChatSessionController(makeInit());
    expect(ctrl).toBeDefined();
    expect(typeof ctrl.startRootRun).toBe('function');
    expect(typeof ctrl.resume).toBe('function');
    expect(typeof ctrl.stop).toBe('function');
    expect(typeof ctrl.canStartRootRun).toBe('function');
  });

  it('canStartRootRun() delegates to chatTuiCanStartRootRun(session)', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    // Fresh session — no run pending
    expect(ctrl.canStartRootRun()).toBe(true);

    // Simulate a pending run
    session.runPromise = new Promise(() => {});
    session.runCompleted = false;
    expect(ctrl.canStartRootRun()).toBe(false);

    // Complete the run
    session.runCompleted = true;
    expect(ctrl.canStartRootRun()).toBe(true);
  });

  it('stop() sets stopRequested on the session', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    expect(session.stopRequested).toBe(false);
    ctrl.stop();
    expect(session.stopRequested).toBe(true);
  });

  it('stop() is idempotent', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    ctrl.stop();
    ctrl.stop();
    expect(session.stopRequested).toBe(true);
  });

  it('canStartRootRun returns false after stop() when a runPromise is set', () => {
    const session = makeSession({
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    const ctrl = createChatSessionController(makeInit({ session }));
    // stop doesn't affect canStartRootRun on its own — it's the runPromise
    // that gates it
    expect(ctrl.canStartRootRun()).toBe(false);
    ctrl.stop();
    expect(ctrl.canStartRootRun()).toBe(false); // runPromise still pending
  });

  it('reads the shared detach-subagents setting key when stopping an active stream', () => {
    const runtimeHost = { emit: vi.fn() };
    const session = makeSession({
      streamId: 'stream-1',
      runtimeHost,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    mocks.workspaceGet.mockReturnValue(true);
    ctrl.stop();

    expect(mocks.workspaceGet).toHaveBeenCalledWith(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    );
    expect(mocks.stopAgentStream).toHaveBeenCalledWith('stream-1', {
      detachActiveChildren: true,
      runtimeHost,
    });
  });

  it('reserves the root-run slot before tryResumeStream awaits persisted state', async () => {
    const preload = deferred();
    const session = makeSession({ runCompleted: true });
    const snapshotStore = makeResumeSnapshotStore({
      preload: () => preload.promise,
      executionId: undefined,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resumed = ctrl.tryResumeStream('stream-1');

    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(ctrl.canStartRootRun()).toBe(false);

    preload.resolve(undefined);
    await expect(resumed).resolves.toBe(false);
    expect(session.runCompleted).toBe(true);
  });

  it('treats a busy CLI root slot as a non-dropping wake outcome', async () => {
    const session = makeSession({
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    const snapshotStore = makeResumeSnapshotStore({});
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(ctrl.tryResumeStream('child-stream')).resolves.toBe(true);

    expect(snapshotStore.preload).not.toHaveBeenCalled();
  });

  it('allows WAITING results when auto-resuming queued tool-use snapshots', async () => {
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    const snapshotStore = makeResumeSnapshotStore({
      executionId: 'exec-1',
      config,
    });
    mocks.resolveAndResumeStream.mockImplementationOnce(
      async (
        _streamId: StreamTabId,
        ports: { resumeToolUseSnapshot(snapshot: unknown): Promise<boolean> },
      ) => ports.resumeToolUseSnapshot({ version: 2 }),
    );
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(ctrl.tryResumeStream('stream-1')).resolves.toBe(true);

    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      'stream-1',
      { version: 2 },
      expect.any(Object),
      expect.objectContaining({ allowWaitingResult: true }),
    );
    expect(mocks.projectStreamTranscript).toHaveBeenCalledWith('stream-1', {
      finalize: true,
    });
  });

  it('does not auto-resume after stop during helper-model setup', async () => {
    const helperModel = deferred();
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    const snapshotStore = makeResumeSnapshotStore({
      executionId: 'exec-1',
      config,
    });
    mocks.setCliHelperModel.mockReturnValueOnce(helperModel.promise);
    mocks.resolveAndResumeStream.mockImplementationOnce(
      async (_streamId: StreamTabId, ports: ResumeStreamPorts) =>
        ports.isCancellationRequested?.() !== true,
    );
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resumed = ctrl.tryResumeStream('stream-1');
    await vi.waitFor(() =>
      expect(mocks.setCliHelperModel).toHaveBeenCalledWith(config.model),
    );
    ctrl.stop();
    helperModel.resolve(undefined);

    await expect(resumed).resolves.toBe(false);
    expect(mocks.resolveAndResumeStream).toHaveBeenCalledWith(
      'stream-1',
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
    expect(mocks.projectStreamTranscript).not.toHaveBeenCalledWith('stream-1', {
      finalize: true,
    });
    expect(mocks.notify).not.toHaveBeenCalledWith({ kind: 'agentFinished' });
  });

  it('does not finalize the stream transcript when auto-resume returns false', async () => {
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    const snapshotStore = makeResumeSnapshotStore({
      executionId: 'exec-1',
      config,
    });
    mocks.resolveAndResumeStream.mockResolvedValueOnce(false);
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(ctrl.tryResumeStream('stream-1')).resolves.toBe(false);

    expect(mocks.projectStreamTranscript).not.toHaveBeenCalledWith('stream-1', {
      finalize: true,
    });
  });
});
