// Unit tests for the chat-session controller's run-slot ownership, stop and
// resume paths, and presentation-host lifecycle. Agent execution itself is
// mocked; the session surfaces the controller reasons about (execution
// registry, event hub, stream status, host interactions) are the real
// runtime objects wherever a test asserts through them.

import PQueue from 'p-queue';
import pDefer from 'p-defer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  runAgent: vi.fn(),
  stopAgentStream: vi.fn(),
  cancelInteractions: vi.fn(),
  workspaceGet: vi.fn(),
  globalGet: vi.fn(),
  getExecutionStore: vi.fn(),
  setCliHelperModel: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  presentationHostClose: vi.fn(),
  defaultSession: vi.fn(),
  streamIsActiveOrResuming: vi.fn(),
  getActiveExecutionIds: vi.fn(),
  getExecutionHandle: vi.fn(),
  addExecutionRegistrationListener: vi.fn(),
  addChildActivationListener: vi.fn(),
  detachHostInteractions: vi.fn(),
  attachTerminalResultToast: vi.fn(),
  attachSessionSignalsAdapter: vi.fn(),
  createTuiHostInteractions: vi.fn(),
  resolveAndResumeStream: vi.fn(),
  resumeQueuedToolUseFromResumeData: vi.fn(),
  resumeToolUseFromResumeData: vi.fn(),
  syncStreamLog: vi.fn(),
  notify: vi.fn(),
  appendLocalAssistantTranscript: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
  clearLocalTranscript: vi.fn(),
  moveLocalTranscriptToStream: vi.fn(),
  readCliToolUseResumeData: vi.fn(),
  followUpEnqueue: vi.fn(),
  sessionEventEmit: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: mocks.getExecutionStore,
}));

vi.mock('@agent/runtime/resolveAndResumeStream', () => ({
  resolveAndResumeStream: mocks.resolveAndResumeStream,
}));

vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseFromResumeData: mocks.resumeQueuedToolUseFromResumeData,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
  resumeToolUseFromResumeData: mocks.resumeToolUseFromResumeData,
}));

vi.mock('@agent/runtime/runAgent', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.defaultSession,
  defaultSession: mocks.defaultSession,
}));

vi.mock('@agent/runtime/terminalResultToast', () => ({
  attachTerminalResultToast: mocks.attachTerminalResultToast,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    workspaceState: {
      get: mocks.workspaceGet,
    },
    globalState: {
      get: mocks.globalGet,
    },
  }),
  tryPlatform: () => ({
    workspaceState: {
      get: mocks.workspaceGet,
    },
    globalState: {
      get: mocks.globalGet,
    },
  }),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  setCliHelperModel: mocks.setCliHelperModel,
}));

vi.mock('@cli/runtime/cliPresentationHost', () => ({
  createCliRuntimeHost: mocks.createCliRuntimeHost,
}));

vi.mock('@cli/chat/tui/state/subscribeApprovals', () => ({
  createTuiHostInteractions: mocks.createTuiHostInteractions,
}));

vi.mock('@cli/chat/tui/state/sessionSignalsAdapter', () => ({
  attachSessionSignalsAdapter: mocks.attachSessionSignalsAdapter,
}));

vi.mock('@cli/chat/tui/state/subscribeStreamLog', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@cli/chat/tui/state/subscribeStreamLog')
    >();
  return { ...actual, syncStreamLog: mocks.syncStreamLog };
});

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

vi.mock('@cli/runtime/toolUseResumeData', () => ({
  readCliToolUseResumeData: mocks.readCliToolUseResumeData,
}));

import type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { ExecutionInteractionOwnership } from '@agent/runtime/executionInteractionOwnership';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { ResumeStreamPorts } from '@agent/runtime/resolveAndResumeStream';
import type { ResumeQueuedToolUseOptions } from '@agent/runtime/resumeQueuedToolUse';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { readCliRunOutcome } from '@cli/runtime/terminalStatus';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import {
  patchSessionMeta,
  rootRunPending,
  rootRunStreamId,
  rootStreamId,
  sessionMeta,
} from '@cli/chat/tui/state/cliState';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStopActiveRun,
  chatTuiCanStartRootRun,
  chatTuiIsResumableIdleOnExit,
  chatTuiSigintAction,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { TEXRA_APPROVAL_POLICY_DEFAULT } from '@shared/approvalPolicy';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { createFakeKv } from '@test/support/FakeExecutionKVStore';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { StreamSnapshotStore } from '@transcript';

/**
 * Session fixture in the states the controller is exercised from. The
 * run-claim triple is owned by {@link TuiSession}, so a fixture reaches a
 * pending or completed claim through the same transitions production uses.
 */
interface SessionFixture {
  readonly streamId?: StreamTabId;
  readonly interruptedStreamId?: StreamTabId;
  readonly executionId?: string;
  readonly presentationHost?: CliRuntimeHost;
  readonly runPromise?: Promise<void>;
  readonly runCompleted?: boolean;
  readonly stopRequested?: boolean;
}

function makeSession(overrides: SessionFixture = {}): TuiSession {
  const session = new TuiSession();
  if (overrides.runPromise) session.markRunPending(overrides.runPromise);
  if (overrides.runCompleted) session.markRunCompleted();
  if (overrides.streamId) session.streamId = overrides.streamId;
  session.interruptedStreamId = overrides.interruptedStreamId;
  session.executionId = overrides.executionId;
  session.presentationHost = overrides.presentationHost;
  session.stopRequested = overrides.stopRequested ?? false;
  return session;
}

function makePresentationHost(): CliRuntimeHost {
  return { emit: vi.fn() } as unknown as CliRuntimeHost;
}

function makeSessionContext(): CliContext {
  return createTestCliContext({
    cwd: '/tmp/test',
    mode: 'interactive',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    quietLogs: true,
    helperModel: 'test-model',
    commandName: 'chat',
    apiMode: 'included',
  });
}

function makeRunRequest(instruction: string): AgentConfigPayload {
  return {
    agent: 'chat',
    model: 'gpt54',
    instruction,
    workingDirectory: '/tmp/test',
    agentCategory: 'toolUse',
  };
}

type ToolUseRunResult<Outcome> = {
  category: 'toolUse';
  executionId: ExecutionId;
  outcome: Outcome;
  streamId: StreamTabId;
};

function makeInit(
  overrides: Partial<ChatSessionControllerInit> = {},
): ChatSessionControllerInit {
  return {
    session: makeSession(),
    runtimeSession: mocks.defaultSession(),
    getSessionContext: () => makeSessionContext(),
    disposers: [],
    followUpQueue: new PQueue({ concurrency: 1 }),
    snapshotStore: new StreamSnapshotStore(),
    ...overrides,
  };
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
  readonly load?: () => Promise<void>;
  readonly executionId?: string | undefined;
  readonly persistedExecutionId?: string | undefined;
  readonly config?: AgentConfig | undefined;
  readonly parentStreamId?: StreamTabId | undefined;
}): StreamSnapshotStore {
  return {
    preload: vi.fn(options.preload ?? (async () => undefined)),
    load: vi.fn(options.load ?? (async () => undefined)),
    read: vi.fn(async () => ({
      runUsage: {},
      todos: [],
      plan: undefined,
    })),
    getRunMetadata: vi.fn(() => ({
      executionId: options.executionId,
      config: options.config,
      identity: options.config
        ? { kind: 'agent' as const, agent: options.config.agent }
        : undefined,
    })),
    readPersistedExecutionId: vi.fn(async () => options.persistedExecutionId),
    getParentStreamId: vi.fn(() => options.parentStreamId),
  } as unknown as StreamSnapshotStore;
}

function makeResolvedResume() {
  return createToolUseResumeData({
    executionId: 'exec-resume' as ExecutionId,
    streamId: 'stream-resume' as StreamTabId,
    agentConfig: makeResumeConfig(),
  });
}

function makeAutoResumeData() {
  return createToolUseResumeData({
    executionId: 'exec-1' as ExecutionId,
    streamId: 'stream-1' as StreamTabId,
    agentConfig: makeResumeConfig(),
  });
}

/**
 * Installs what `defaultSession()` answers with. Every surface is a stub the
 * controller can call; a test that asserts through a real runtime object swaps
 * just that surface in. `defaultSession` is a bare mock, so the override map is
 * untyped here exactly as the returned session is.
 */
function installSession(overrides: Record<string, unknown> = {}): void {
  const executions = {
    stopAgentStream: mocks.stopAgentStream,
    getActiveIds: mocks.getActiveExecutionIds,
    getHandle: mocks.getExecutionHandle,
    addRegistrationListener: mocks.addExecutionRegistrationListener,
    addChildActivationListener: mocks.addChildActivationListener,
  };
  mocks.defaultSession.mockReturnValue({
    approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
    useHostInteractions: vi.fn(() => mocks.detachHostInteractions),
    interactions: { cancel: mocks.cancelInteractions },
    events: { emit: mocks.sessionEventEmit },
    followUps: { restore: mocks.followUpEnqueue },
    approvals: { registerStreamParent: vi.fn() },
    status: { isActiveOrResuming: mocks.streamIsActiveOrResuming },
    executions: {
      ...executions,
      // The stubbed registry still answers the three surfaces the real
      // ownership index reads, so the controller runs against real ownership.
      interactionOwnership: new ExecutionInteractionOwnership(
        executions as unknown as ExecutionRegistry,
      ),
    },
    transcripts: { ensureLoaded: vi.fn(async () => undefined) },
    ...overrides,
  });
}

/**
 * Installs a session whose interaction, event, status, and execution surfaces
 * are the real runtime objects rather than per-mock stubs.
 */
function installOwnerSession(): {
  readonly events: SessionEventHub;
  readonly status: StreamStatusMachine;
  readonly executions: ExecutionRegistry;
  readonly interactions: SessionHostInteractions;
} {
  const events = new SessionEventHub();
  const status = new StreamStatusMachine(events);
  const executions = new ExecutionRegistry({ events, streamStatus: status });
  const interactions = new SessionHostInteractions();
  installSession({
    useHostInteractions: (adapter: Parameters<typeof interactions.use>[0]) =>
      interactions.use(adapter),
    interactions,
    events,
    status,
    executions,
  });
  return { events, status, executions, interactions };
}

function trackRunningExecution(
  executions: ExecutionRegistry,
  executionId: string,
  parentStreamId: StreamTabId,
  streamId: StreamTabId,
  agent: string,
): void {
  executions.trackAgentExecution(
    testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId: streamId,
      agent,
    }),
    { status: STREAM_PHASE.RUNNING },
  );
}

function resumeWithAutoResumeData(): void {
  mocks.resolveAndResumeStream.mockImplementationOnce(
    async (
      _streamId: StreamTabId,
      ports: { resumeToolUse(snapshot: unknown): Promise<boolean> },
    ) => ports.resumeToolUse(makeAutoResumeData()),
  );
}

function makeInterruptedController(
  runPromise: Promise<void>,
  runCompleted: boolean,
  snapshotStore = makeResumeSnapshotStore({
    executionId: 'exec-1',
    config: makeResumeConfig(),
  }),
) {
  const session = makeSession({
    streamId: 'stream-1' as StreamTabId,
    interruptedStreamId: 'stream-1' as StreamTabId,
    executionId: 'exec-1',
    runPromise,
    runCompleted,
    stopRequested: true,
  });
  resumeWithAutoResumeData();
  return {
    ctrl: createChatSessionController(makeInit({ session, snapshotStore })),
    session,
  };
}

async function retainInterruptedFollowUp(
  ctrl: ReturnType<typeof createChatSessionController>,
  text: string,
): Promise<void> {
  mocks.resolveAndResumeStream.mockReset().mockResolvedValueOnce(false);
  const admission = ctrl.admitInterruptedFollowUp({ text });
  expect(admission.kind).toBe('accepted');
  if (admission.kind !== 'accepted') return;
  await expect(admission.completion).resolves.toBe(false);
}

async function expectInterruptedRetry(
  ctrl: ReturnType<typeof createChatSessionController>,
  expectedTexts: readonly string[],
): Promise<void> {
  resumeWithAutoResumeData();
  const retry = ctrl.admitInterruptedFollowUp({ text: 'Retry.' });
  expect(retry.kind).toBe('accepted');
  if (retry.kind !== 'accepted') return;
  await expect(retry.completion).resolves.toBe(true);
  expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledWith(
    'stream-1',
    makeAutoResumeData(),
    expect.objectContaining({
      extraFollowUps: expectedTexts.map((text) => ({ text })),
    }),
  );
}

describe('CLI terminal outcome resolution', () => {
  beforeEach(() => {
    mocks.getExecutionStore.mockReset();
  });

  it('prefers the persisted post-shutdown outcome', async () => {
    mocks.getExecutionStore.mockReturnValue(
      createFakeKv(undefined, {
        readMeta: vi.fn().mockResolvedValue({
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      }),
    );

    await expect(
      readCliRunOutcome({
        category: 'toolUse',
        executionId: 'shutdown-race',
        outcome: RUN_OUTCOME.COMPLETED,
        streamId: 'shutdown-race',
      } as Parameters<typeof readCliRunOutcome>[0]),
    ).resolves.toBe(RUN_OUTCOME.CANCELLED);
  });

  it('reports an outcome read failure and retains the completed run', async () => {
    const reportReadFailure = vi.fn();
    mocks.getExecutionStore.mockReturnValue(
      createFakeKv(undefined, {
        readMeta: vi.fn().mockRejectedValue(new Error('metadata read failed')),
      }),
    );

    await expect(
      readCliRunOutcome(
        {
          category: 'toolUse',
          executionId: 'broken-storage',
          outcome: RUN_OUTCOME.COMPLETED,
          streamId: 'broken-storage',
        } as Parameters<typeof readCliRunOutcome>[0],
        reportReadFailure,
      ),
    ).resolves.toBe(RUN_OUTCOME.COMPLETED);
    expect(reportReadFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message:
          'Could not verify the persisted outcome for execution broken-storage; using the current run outcome: metadata read failed',
        cause: expect.any(Error),
      }),
    );
  });
});

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

describe('createChatSessionController', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();

    mocks.executeAgent.mockResolvedValue({
      category: 'toolUse',
      executionId: 'exec-start',
      outcome: RUN_OUTCOME.COMPLETED,
      streamId: 'stream-start',
    });
    mocks.runAgent.mockImplementation(
      async (
        request: { config: unknown; executionId: ExecutionId },
        options: object,
      ) => {
        return mocks.executeAgent(request.config, request.executionId, options);
      },
    );
    // Return the caller-provided default (false for DETACH_SUBAGENTS_ON_STOP,
    // undefined for roster keys) — a blanket `false` is not a valid persisted
    // value for AGENT_ROSTER_SELECTION, which agent resolution now reads.
    mocks.workspaceGet.mockImplementation(
      (_key: unknown, defaultValue?: unknown) => defaultValue,
    );
    mocks.globalGet.mockImplementation(
      (_key: unknown, defaultValue?: unknown) => defaultValue,
    );
    mocks.setCliHelperModel.mockResolvedValue(undefined);
    mocks.presentationHostClose.mockResolvedValue(undefined);
    mocks.createCliRuntimeHost.mockReturnValue({
      close: mocks.presentationHostClose,
      emit: vi.fn(),
    });
    mocks.streamIsActiveOrResuming.mockReturnValue(false);
    mocks.getActiveExecutionIds.mockReturnValue([]);
    mocks.addExecutionRegistrationListener.mockReturnValue(vi.fn());
    mocks.addChildActivationListener.mockReturnValue(vi.fn());
    mocks.attachTerminalResultToast.mockReturnValue(vi.fn());
    mocks.attachSessionSignalsAdapter.mockReturnValue(vi.fn());
    mocks.createTuiHostInteractions.mockReturnValue({});
    installSession();
    mocks.resolveAndResumeStream.mockResolvedValue(true);
    mocks.resumeQueuedToolUseFromResumeData.mockImplementation(
      async (...args: unknown[]) => {
        const options = args[2] as ResumeQueuedToolUseOptions;
        options.onFollowUpQueueReady?.({
          streamId: 'stream:test' as StreamTabId,
          generation: 1,
          kind: 'recovery',
        });
        return true;
      },
    );
    mocks.resumeToolUseFromResumeData.mockResolvedValue({
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      executionId: 'exec-resume',
      streamId: 'stream-resume',
    });
    rootStreamId.set(undefined);
    rootRunPending.set(false);
    rootRunStreamId.set(undefined);
  });

  it('does not surface an intentional stop as an error', async () => {
    const run = pDefer<never>();
    const session = makeSession();
    mocks.executeAgent.mockReturnValueOnce(run.promise);
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.startRootRun(makeRunRequest('Check the draft.'));
    await vi.waitFor(() => expect(mocks.executeAgent).toHaveBeenCalledOnce());
    ctrl.stop();
    run.reject(new Error('run stopped'));
    await session.runPromise;

    expect(mocks.appendLocalErrorTranscript).not.toHaveBeenCalled();
    expect(session.runExitCode).toBe(CliExitCode.Success);
  });

  it('does not delete a flow after the run lifecycle has taken ownership', async () => {
    const session = makeSession();
    mocks.executeAgent.mockImplementationOnce(
      async (
        _config: unknown,
        _executionId: unknown,
        options: { readonly onRun?: () => void },
      ) => {
        options.onRun?.();
        throw new Error('recovery remains resumable');
      },
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.startRootRun(makeRunRequest('Continue the recoverable proof.'));
    await session.runPromise;

    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'recovery remains resumable',
    );
  });

  it('canStartRootRun() delegates to chatTuiCanStartRootRun(session)', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    // Fresh session — no run pending
    expect(ctrl.canStartRootRun()).toBe(true);

    // Simulate a pending run
    session.markRunPending(new Promise(() => {}));
    expect(ctrl.canStartRootRun()).toBe(false);

    // Complete the run
    session.markRunCompleted();
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
    const session = makeSession({
      streamId: 'stream-1',
      presentationHost: makePresentationHost(),
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
    });
  });

  it('stops the focused root while preserving its agent children', () => {
    const session = makeSession({
      streamId: 'root-stream',
      presentationHost: makePresentationHost(),
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stopStream('root-stream');

    expect(session.stopRequested).toBe(true);
    expect(session.interruptedStreamId).toBe('root-stream');
    expect(mocks.cancelInteractions).toHaveBeenCalledWith({
      streamId: 'root-stream',
      cause: 'Run interrupted.',
    });
    expect(mocks.stopAgentStream).toHaveBeenCalledWith('root-stream', {
      detachActiveChildren: true,
    });
    expect(mocks.workspaceGet).not.toHaveBeenCalled();
  });

  it('stops one focused child without stopping the root session', () => {
    const session = makeSession({
      streamId: 'root-stream',
      presentationHost: makePresentationHost(),
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stopStream('child-a');

    expect(session.stopRequested).toBe(false);
    expect(session.interruptedStreamId).toBeUndefined();
    expect(mocks.cancelInteractions).toHaveBeenCalledWith({
      streamId: 'child-a',
      cause: 'Run interrupted.',
    });
    expect(mocks.stopAgentStream).toHaveBeenCalledWith('child-a', {
      detachActiveChildren: true,
    });
  });

  it('keeps detached-child approvals answerable after the stopped root finalizes', async () => {
    const rootStream = 'root-stream' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;
    const { executions, interactions } = installOwnerSession();
    const adapterDecision = pDefer<{ action: 'approve' | 'reject' }>();
    const requestBashApproval = vi.fn(() => adapterDecision.promise);
    const disposeAdapter = vi.fn();
    const detachResultToast = vi.fn();
    const detachRunFacts = vi.fn();
    const presentationHost = {
      emit: vi.fn(),
      close: mocks.presentationHostClose,
      attachRunProgressRenderer: vi.fn(() => vi.fn()),
    } as unknown as CliRuntimeHost;
    mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
    mocks.createTuiHostInteractions.mockReturnValue({
      requestBashApproval,
      cancel: vi.fn(),
      dispose: disposeAdapter,
    });
    mocks.attachTerminalResultToast.mockReturnValue(detachResultToast);
    mocks.attachSessionSignalsAdapter.mockReturnValue(detachRunFacts);

    const rootRun = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
    mocks.executeAgent.mockImplementationOnce(
      async (
        _config: unknown,
        executionId: ExecutionId,
        options: { readonly onStreamResolved?: (id: StreamTabId) => void },
      ) => {
        const rootHandle = testExecutionHandle({
          executionId,
          parentStreamId: rootStream,
          agent: 'root',
        });
        const childHandle = testExecutionHandle({
          executionId: 'child-exec',
          parentStreamId: rootStream,
          childStreamId: childStream,
          agent: 'child',
        });
        rootHandle.attachInterruptHandler({
          interrupt: () => {
            executions.untrack(rootHandle.executionId);
            rootRun.resolve({
              category: 'toolUse',
              executionId: rootHandle.executionId as ExecutionId,
              outcome: RUN_OUTCOME.CANCELLED,
              streamId: rootStream,
            });
          },
        });
        executions.trackAgentExecution(rootHandle, {
          status: STREAM_PHASE.RUNNING,
        });
        executions.trackAgentExecution(childHandle, {
          status: STREAM_PHASE.RUNNING,
        });
        options.onStreamResolved?.(rootStream);
        return rootRun.promise;
      },
    );

    const session = makeSession();
    const disposers: Array<() => void> = [];
    const ctrl = createChatSessionController(makeInit({ session, disposers }));
    ctrl.startRootRun(makeRunRequest('Delegate the calculation.'));
    await vi.waitFor(() => expect(session.streamId).toBe(rootStream));

    ctrl.stopStream(rootStream);
    await session.runPromise;

    expect(session.runCompleted).toBe(true);
    expect(
      executions.getAgentHandleByStream(childStream)?.isChildExecution,
    ).toBe(false);
    expect(disposeAdapter).not.toHaveBeenCalled();
    expect(detachResultToast).toHaveBeenCalledOnce();
    expect(mocks.presentationHostClose).not.toHaveBeenCalled();

    const approval = interactions.requestBashApproval({
      command: 'printf child',
      streamId: childStream,
    });
    await vi.waitFor(() => expect(requestBashApproval).toHaveBeenCalledOnce());
    adapterDecision.resolve({ action: 'approve' });
    await expect(approval).resolves.toEqual({ action: 'approve' });

    executions.untrack('child-exec');
    await vi.waitFor(() => {
      expect(disposeAdapter).toHaveBeenCalledOnce();
      expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
    });
    expect(detachResultToast).toHaveBeenCalledOnce();
    expect(detachRunFacts).not.toHaveBeenCalled();

    for (const dispose of disposers) dispose();
    expect(detachRunFacts).toHaveBeenCalledOnce();
    expect(disposeAdapter).toHaveBeenCalledOnce();
    executions.dispose();
  });

  it('releases a later root host while an earlier detached child remains active', async () => {
    const { executions } = installOwnerSession();
    const hostA = { emit: vi.fn(), close: vi.fn() };
    const hostB = { emit: vi.fn(), close: vi.fn() };
    const disposeAdapterA = vi.fn();
    const disposeAdapterB = vi.fn();
    const runA = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.COMPLETED>>();
    const runB = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.COMPLETED>>();
    const rootAStream = 'root-a' as StreamTabId;
    const childAStream = 'child-a' as StreamTabId;
    const rootBStream = 'root-b' as StreamTabId;
    let childAExecutionId: ExecutionId | undefined;
    let rootAExecutionId: ExecutionId | undefined;
    let rootBExecutionId: ExecutionId | undefined;

    mocks.createCliRuntimeHost
      .mockReturnValueOnce(hostA)
      .mockReturnValueOnce(hostB);
    mocks.createTuiHostInteractions
      .mockReturnValueOnce({
        cancel: vi.fn(),
        dispose: disposeAdapterA,
      })
      .mockReturnValueOnce({
        cancel: vi.fn(),
        dispose: disposeAdapterB,
      });
    mocks.executeAgent
      .mockImplementationOnce(
        async (
          _config: unknown,
          executionId: ExecutionId,
          options: { readonly onStreamResolved?: (id: StreamTabId) => void },
        ) => {
          rootAExecutionId = executionId;
          childAExecutionId = 'child-a-exec' as ExecutionId;
          trackRunningExecution(
            executions,
            executionId,
            rootAStream,
            rootAStream,
            'root-a',
          );
          trackRunningExecution(
            executions,
            childAExecutionId,
            rootAStream,
            childAStream,
            'child-a',
          );
          options.onStreamResolved?.(rootAStream);
          return runA.promise;
        },
      )
      .mockImplementationOnce(
        async (
          _config: unknown,
          executionId: ExecutionId,
          options: { readonly onStreamResolved?: (id: StreamTabId) => void },
        ) => {
          rootBExecutionId = executionId;
          trackRunningExecution(
            executions,
            executionId,
            rootBStream,
            rootBStream,
            'root-b',
          );
          options.onStreamResolved?.(rootBStream);
          return runB.promise;
        },
      );

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    const config = makeRunRequest('Check interaction ownership.');

    ctrl.startRootRun(config);
    await vi.waitFor(() => expect(rootAExecutionId).toBeDefined());
    executions.untrack(rootAExecutionId!);
    runA.resolve({
      category: 'toolUse',
      executionId: rootAExecutionId!,
      outcome: RUN_OUTCOME.COMPLETED,
      streamId: rootAStream,
    });
    await session.runPromise;
    expect(hostA.close).not.toHaveBeenCalled();

    ctrl.startRootRun(config);
    await vi.waitFor(() => expect(rootBExecutionId).toBeDefined());
    executions.untrack(rootBExecutionId!);
    runB.resolve({
      category: 'toolUse',
      executionId: rootBExecutionId!,
      outcome: RUN_OUTCOME.COMPLETED,
      streamId: rootBStream,
    });
    await session.runPromise;

    expect(hostB.close).toHaveBeenCalledOnce();
    expect(disposeAdapterB).toHaveBeenCalledOnce();
    expect(hostA.close).not.toHaveBeenCalled();
    expect(disposeAdapterA).not.toHaveBeenCalled();

    executions.untrack(childAExecutionId!);
    await vi.waitFor(() => {
      expect(hostA.close).toHaveBeenCalledOnce();
      expect(disposeAdapterA).toHaveBeenCalledOnce();
    });
    executions.dispose();
  });

  it('retains a root host while a child is activating', async () => {
    const { executions } = installOwnerSession();
    const presentationHost = { emit: vi.fn(), close: vi.fn() };
    const disposeAdapter = vi.fn();
    const rootStream = 'activation-root' as StreamTabId;
    const childStream = 'activation-child' as StreamTabId;
    const childExecutionId = 'activation-child-exec' as ExecutionId;

    mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
    mocks.createTuiHostInteractions.mockReturnValue({
      cancel: vi.fn(),
      dispose: disposeAdapter,
    });
    mocks.executeAgent.mockImplementationOnce(
      async (
        _config: unknown,
        executionId: ExecutionId,
        options: { readonly onStreamResolved?: (id: StreamTabId) => void },
      ) => {
        trackRunningExecution(
          executions,
          executionId,
          rootStream,
          rootStream,
          'root',
        );
        options.onStreamResolved?.(rootStream);
        executions.reserveChildActivation({
          executionId: childExecutionId,
          parentStreamId: rootStream,
          childStreamId: childStream,
        });
        executions.untrack(executionId);
        return {
          category: 'toolUse',
          executionId,
          outcome: RUN_OUTCOME.COMPLETED,
          streamId: rootStream,
        };
      },
    );

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    ctrl.startRootRun(makeRunRequest('Start a child and finish immediately.'));
    await session.runPromise;

    expect(presentationHost.close).not.toHaveBeenCalled();
    expect(disposeAdapter).not.toHaveBeenCalled();

    trackRunningExecution(
      executions,
      childExecutionId,
      rootStream,
      childStream,
      'child',
    );
    expect(presentationHost.close).not.toHaveBeenCalled();

    executions.untrack(childExecutionId);
    await vi.waitFor(() => {
      expect(presentationHost.close).toHaveBeenCalledOnce();
      expect(disposeAdapter).toHaveBeenCalledOnce();
    });
    executions.dispose();
  });

  it('does not overlap terminal-result presenters across surviving host generations', async () => {
    const hostA = { emit: vi.fn(), close: vi.fn() };
    const hostB = { emit: vi.fn(), close: vi.fn() };
    const resultPresenters = new Set<(message: string) => void>();
    mocks.createCliRuntimeHost
      .mockReturnValueOnce(hostA)
      .mockReturnValueOnce(hostB);
    mocks.attachTerminalResultToast.mockImplementation(() => {
      const host =
        mocks.attachTerminalResultToast.mock.calls.length === 1 ? hostA : hostB;
      const present = (message: string) =>
        host.emit('requestShowError', { message });
      resultPresenters.add(present);
      return () => resultPresenters.delete(present);
    });
    const runA = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
    const runB = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.FAILED>>();
    mocks.runAgent
      .mockReturnValueOnce(runA.promise)
      .mockReturnValueOnce(runB.promise);

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    const config = makeRunRequest('Check presenter ownership.');
    ctrl.startRootRun(config);
    session.streamId = 'root-a' as StreamTabId;
    ctrl.stopStream('root-a' as StreamTabId);
    for (const present of resultPresenters) present('Failure A');
    runA.resolve({
      category: 'toolUse',
      executionId: 'exec-a' as ExecutionId,
      outcome: RUN_OUTCOME.CANCELLED,
      streamId: 'root-a' as StreamTabId,
    });
    await session.runPromise;

    expect(resultPresenters).toHaveLength(0);
    expect(hostA.close).toHaveBeenCalledOnce();

    ctrl.startRootRun(config);
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(2));
    expect(mocks.attachTerminalResultToast).toHaveBeenCalledTimes(2);
    expect(session.runCompleted).toBe(false);
    await vi.waitFor(() => expect(resultPresenters).toHaveLength(1));
    for (const present of resultPresenters) present('Failure B');
    runB.resolve({
      category: 'toolUse',
      executionId: 'exec-b' as ExecutionId,
      outcome: RUN_OUTCOME.FAILED,
      streamId: 'root-b' as StreamTabId,
    });
    await session.runPromise;

    expect(hostA.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message: 'Failure A',
    });
    expect(hostB.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message: 'Failure B',
    });
    expect(hostA.close).toHaveBeenCalledOnce();
    expect(hostB.close).toHaveBeenCalledOnce();
    expect(resultPresenters).toHaveLength(0);
  });

  it('cannot miss the final survivor untracking at host-listener registration', async () => {
    const presentationHost = {
      emit: vi.fn(),
      close: mocks.presentationHostClose,
    } as unknown as CliRuntimeHost;
    const detachRegistrationListener = vi.fn();
    let childActive = true;
    mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
    mocks.getActiveExecutionIds.mockImplementation(() =>
      childActive ? ['child-exec'] : [],
    );
    mocks.getExecutionHandle.mockImplementation(() =>
      childActive ? { presentationHost } : undefined,
    );
    mocks.addExecutionRegistrationListener.mockImplementation(
      (listener: () => void) => {
        // Adversarial boundary: the final survivor disappears while the
        // listener is being installed, before the initial liveness check.
        childActive = false;
        listener();
        return detachRegistrationListener;
      },
    );

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    ctrl.startRootRun(makeRunRequest('Check listener registration.'));
    await session.runPromise;

    expect(session.runCompleted).toBe(true);
    expect(mocks.addExecutionRegistrationListener).toHaveBeenCalledOnce();
    expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
    expect(mocks.detachHostInteractions).toHaveBeenCalledOnce();
    expect(detachRegistrationListener).toHaveBeenCalledOnce();
  });

  it('reserves the root-run slot before tryResumeStream awaits persisted state', async () => {
    const preload = pDefer<void>();
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

  it('reserves the root-run slot before resume() awaits the resolution', async () => {
    const configRead = pDefer<null>();
    mocks.getExecutionStore.mockReturnValue({
      readConfig: () => configRead.promise,
    });
    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = ctrl.resume('aaaaaa' as ExecutionId);

    // The claim (tryClaimRootRunSlot) must land synchronously, before
    // resume() ever reaches its first await — same contract as
    // tryResumeStream above.
    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(ctrl.canStartRootRun()).toBe(false);

    configRead.resolve(null);
    await resumed;
    expect(session.runCompleted).toBe(true);
  });

  it('retains the configuration of a manually resumed conversation', async () => {
    const config = makeResumeConfig({
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflow: ['builtInWorkflow:physicsReviewer'],
        toolUse: ['builtInToolUse:orchestrator'],
      },
    });
    const ctrl = createChatSessionController(makeInit());

    await ctrl.resume('exec-resume' as ExecutionId, {
      ...makeResolvedResume(),
      agentConfig: config,
    });

    expect(sessionMeta.get()).toMatchObject({
      teamName: 'Physicist',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: config.delegationAgentScope,
    });
  });

  it('treats a manually resumed subagent returning to WAITING as a successful turn', async () => {
    const session = makeSession({ runCompleted: true });
    mocks.resumeToolUseFromResumeData.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: STREAM_PHASE.WAITING,
      executionId: 'exec-resume',
      streamId: 'stream-resume',
    });
    // A fake store, like every other resume test: the real store against
    // this harness's storage-less platform now fails loudly (KVStore no
    // longer converts I/O errors into misses), which resume() treats as a
    // rehydration failure by contract.
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: makeResumeSnapshotStore({}) }),
    );

    await ctrl.resume('exec-resume' as ExecutionId, makeResolvedResume());
    await session.runPromise;

    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(mocks.syncStreamLog).toHaveBeenCalledWith('stream-resume', {
      forceFinal: true,
    });
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
  });

  it('manual resume supersedes stale interrupted recovery state', async () => {
    const session = makeSession({
      interruptedStreamId: 'stream-interrupted' as StreamTabId,
      runCompleted: true,
      stopRequested: true,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: makeResumeSnapshotStore({}) }),
    );

    await ctrl.resume('aaaaaa' as ExecutionId, makeResolvedResume());

    expect(session.streamId).toBe('stream-resume');
    expect(session.interruptedStreamId).toBeUndefined();
    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('transfers an admitted interruption batch to manual resume', async () => {
    const teardown = pDefer<void>();
    const { ctrl } = makeInterruptedController(teardown.promise, true);
    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Preserve this accepted message.',
    });
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') return;

    const manualResume = ctrl.resume(
      'aaaaaa' as ExecutionId,
      makeResolvedResume(),
    );
    teardown.resolve();

    await manualResume;
    await expect(admission.completion).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          drainedFollowUps: [
            {
              text: 'Preserve this accepted message.',
              origin: 'user',
            },
          ],
        }),
      ),
    );
  });

  it('resume() suspended on the resolution keeps a concurrent follow-up wake from also claiming the root-run slot', async () => {
    // resume(A) suspends on the config read (an await-suspension point)
    // with the slot already claimed; a follow-up wake (tryResumeStream for a
    // different stream) fires while A is still suspended. Exactly one caller
    // (A) holds the slot end to end, so B must bail out rather than claim it
    // and start work that A would clobber on waking.
    const configRead = pDefer<null>();
    mocks.getExecutionStore.mockReturnValue({
      readConfig: () => configRead.promise,
    });
    const session = makeSession({ runCompleted: true });
    const snapshotStoreForB = makeResumeSnapshotStore({
      executionId: undefined,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: snapshotStoreForB }),
    );

    const resumeA = ctrl.resume('aaaaaa' as ExecutionId);
    // A is now suspended inside the config read; the slot is
    // already claimed.
    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);

    // The follow-up wake for a different stream fires while A is still
    // suspended. It must bail out synchronously, before touching the
    // snapshot store, because the slot is already held.
    const resumedB = ctrl.tryResumeStream('stream-b');
    expect(snapshotStoreForB.preload).not.toHaveBeenCalled();
    await expect(resumedB).resolves.toBe(false);

    // A remains the sole owner of the slot end to end.
    configRead.resolve(null);
    await resumeA;
    expect(session.runCompleted).toBe(true);
  });

  it('honors a Ctrl-C issued while resume() is still rehydrating and never starts the resumed run', async () => {
    // The early slot claim makes this resume() interruptible before the resumed
    // agent actually starts running. If the user hits Ctrl-C during that
    // rehydration window, resume() must notice `session.stopRequested` and bail
    // out instead of silently starting `resumeToolUseFromResumeData()` once the
    // awaits finish.
    const ensureLoaded = pDefer<void>();
    installSession({
      transcripts: { ensureLoaded: () => ensureLoaded.promise },
    });

    const session = makeSession({
      interruptedStreamId: 'stream-interrupted' as StreamTabId,
      runCompleted: true,
    });
    const snapshotStore = makeResumeSnapshotStore({});
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resumed = ctrl.resume('aaaaaa' as ExecutionId, makeResolvedResume());
    // resume() has claimed the slot and is suspended inside
    // defaultSession().transcripts.ensureLoaded(); session.streamId is
    // already set to the resumed stream.
    expect(session.runPromise).toBeDefined();
    expect(session.streamId).toBe('stream-resume');
    // #8273 regression: the controller must publish the run facts so status
    // rendering can derive the Ctrl-C hint from signals instead of calling
    // impure session closures that memoized renders cache stale.
    expect(rootRunPending.get()).toBe(true);
    expect(rootRunStreamId.get()).toBe('stream-resume');

    const canInterruptActiveRun = chatTuiCanInterruptActiveRun(session);
    const canStopActiveRun = chatTuiCanStopActiveRun({
      runPending: Boolean(session.runPromise && !session.runCompleted),
      streamId: session.streamId,
      status: STREAM_PHASE.WAITING,
    });
    const resumableIdle = chatTuiIsResumableIdleOnExit({
      canInterruptActiveRun,
      canStopActiveRun,
      hasActiveToolUseFlow: false,
    });
    expect(
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun,
        resumableIdle,
      }),
    ).toBe('clean-exit');

    // Ctrl-C fires while resume() is still rehydrating.
    ctrl.stop();
    expect(session.stopRequested).toBe(true);

    ensureLoaded.resolve();
    await resumed;

    expect(mocks.resumeToolUseFromResumeData).not.toHaveBeenCalled();
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedStreamId).toBe('stream-resume');
  });

  it('reports resume rehydration failures without rejecting the TUI submit path', async () => {
    const session = makeSession({
      interruptedStreamId: 'stream-interrupted' as StreamTabId,
      runCompleted: true,
    });
    const snapshotStore = makeResumeSnapshotStore({
      load: async () => {
        throw new Error('snapshot load failed');
      },
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(
      ctrl.resume('aaaaaa' as ExecutionId, makeResolvedResume()),
    ).resolves.toBeUndefined();

    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'snapshot load failed',
    );
    expect(mocks.resumeToolUseFromResumeData).not.toHaveBeenCalled();
    expect(session.runExitCode).toBe(CliExitCode.AgentError);
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedStreamId).toBe('stream-interrupted');
    expect(ctrl.canStartRootRun()).toBe(true);
  });

  it('forwards a stop issued during manual resume helper-model setup', async () => {
    const helperModel = pDefer<void>();
    mocks.setCliHelperModel.mockReturnValueOnce(helperModel.promise);

    const session = makeSession({ runCompleted: true });
    const snapshotStore = {
      load: vi.fn(async () => undefined),
      read: vi.fn(async () => ({
        runUsage: {},
        todos: [],
        plan: undefined,
      })),
      getRunMetadata: vi.fn(() => ({})),
    } as unknown as StreamSnapshotStore;
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );
    const preResolved = makeResolvedResume();
    mocks.resumeToolUseFromResumeData.mockImplementationOnce(
      async (
        _snapshot: unknown,
        options: { readonly isCancellationRequested?: () => boolean },
      ) => ({
        category: 'toolUse',
        outcome: options.isCancellationRequested?.()
          ? RUN_OUTCOME.CANCELLED
          : RUN_OUTCOME.COMPLETED,
        executionId: 'exec-resume',
        streamId: 'stream-resume',
      }),
    );

    const resumeStarted = ctrl.resume('aaaaaa' as ExecutionId, preResolved);
    await vi.waitFor(() =>
      expect(mocks.setCliHelperModel).toHaveBeenCalledWith('demo-model'),
    );

    ctrl.stop();
    helperModel.resolve(undefined);

    await resumeStarted;
    await vi.waitFor(() =>
      expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledWith(
        preResolved,
        expect.objectContaining({
          isCancellationRequested: expect.any(Function),
        }),
      ),
    );
    const resumeOptions = mocks.resumeToolUseFromResumeData.mock
      .calls[0]?.[1] as
      { readonly isCancellationRequested?: () => boolean } | undefined;
    expect(resumeOptions?.isCancellationRequested?.()).toBe(true);
    await session.runPromise;
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
  });

  it('reports a failed persisted-child wake while the CLI root slot is busy', async () => {
    const session = makeSession({
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    const snapshotStore = makeResumeSnapshotStore({});
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(ctrl.tryResumeStream('child-stream')).resolves.toBe(false);

    expect(snapshotStore.preload).not.toHaveBeenCalled();
  });

  it('allows WAITING results when auto-resuming queued tool-use snapshots', async () => {
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    patchSessionMeta({
      cliMultiAgentPresetId: 'stale-team',
      delegationAgentScope: {
        workflow: ['custom:stale'],
        toolUse: ['custom:stale'],
      },
    });
    const snapshotStore = makeResumeSnapshotStore({
      executionId: 'exec-1',
      config,
    });
    resumeWithAutoResumeData();
    mocks.resumeQueuedToolUseFromResumeData.mockImplementationOnce(
      async (
        _streamId: StreamTabId,
        _snapshot: unknown,
        options: ResumeQueuedToolUseOptions,
      ) => {
        options.onResult?.({
          category: 'toolUse',
          outcome: STREAM_PHASE.WAITING,
          executionId: 'exec-1' as ExecutionId,
          streamId: 'stream-1' as StreamTabId,
        });
        return true;
      },
    );
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(ctrl.tryResumeStream('stream-1')).resolves.toBe(true);

    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledWith(
      'stream-1',
      makeAutoResumeData(),
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
    expect(mocks.syncStreamLog).toHaveBeenCalledWith('stream-1', {
      forceFinal: true,
    });
    expect(rootStreamId.get()).toBe('stream-1');
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
    expect(sessionMeta.get().cliMultiAgentPresetId).toBeUndefined();
    expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
  });

  it('launcher resume supersedes stale interrupted recovery state', async () => {
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
    );

    await expect(ctrl.tryResumeStream('stream-1')).resolves.toBe(true);

    expect(session.interruptedStreamId).toBeUndefined();
    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('transfers an admitted interruption batch to launcher resume', async () => {
    const teardown = pDefer<void>();
    const { ctrl } = makeInterruptedController(teardown.promise, true);
    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Transfer this accepted message.',
    });
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') return;

    const launcherResume = ctrl.tryResumeStream('stream-1');
    teardown.resolve();

    await expect(launcherResume).resolves.toBe(true);
    await expect(admission.completion).resolves.toBe(true);
    expect(mocks.followUpEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'recovery' }),
      [{ text: 'Transfer this accepted message.' }],
    );
  });

  it('holds a message submitted while interruption teardown finishes', async () => {
    const teardown = pDefer<void>();
    const { ctrl, session } = makeInterruptedController(
      teardown.promise,
      false,
    );

    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Do not drop this message.',
    });
    expect(admission.kind).toBe('accepted');
    expect(mocks.resolveAndResumeStream).not.toHaveBeenCalled();

    session.markRunCompleted();
    teardown.resolve();
    if (admission.kind !== 'accepted') return;
    await expect(admission.completion).resolves.toBe(true);
    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledWith(
      'stream-1',
      makeAutoResumeData(),
      expect.objectContaining({
        extraFollowUps: [{ text: 'Do not drop this message.' }],
      }),
    );
    expect(session.stopRequested).toBe(false);
  });

  it('batches parallel messages into one interrupted resume', async () => {
    const teardown = pDefer<void>();
    const { ctrl, session } = makeInterruptedController(
      teardown.promise,
      false,
    );

    const first = ctrl.admitInterruptedFollowUp({ text: 'First message.' });
    const second = ctrl.admitInterruptedFollowUp({ text: 'Second message.' });
    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('accepted');
    if (first.kind !== 'accepted' || second.kind !== 'accepted') return;
    expect(second.completion).toBe(first.completion);

    session.markRunCompleted();
    teardown.resolve();
    await expect(first.completion).resolves.toBe(true);
    expect(mocks.resolveAndResumeStream).toHaveBeenCalledOnce();
    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledWith(
      'stream-1',
      makeAutoResumeData(),
      expect.objectContaining({
        extraFollowUps: [
          { text: 'First message.' },
          { text: 'Second message.' },
        ],
      }),
    );
  });

  it('stops batching once ordinary follow-up routing is ready', async () => {
    const resume = pDefer<boolean>();
    const { ctrl } = makeInterruptedController(Promise.resolve(), true);
    mocks.resumeQueuedToolUseFromResumeData.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ResumeQueuedToolUseOptions;
        options.onFollowUpQueueReady?.({
          streamId: 'stream:test' as StreamTabId,
          generation: 1,
          kind: 'recovery',
        });
        return resume.promise;
      },
    );

    const first = ctrl.admitInterruptedFollowUp({ text: 'Resume now.' });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') return;
    await vi.waitFor(() =>
      expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledOnce(),
    );

    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
    resume.resolve(true);
    await expect(first.completion).resolves.toBe(true);
  });

  it('retains the interrupted conversation after a failed resume', async () => {
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
    );
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    expect(session.interruptedStreamId).toBe('stream-1');
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
    expect(session.interruptedStreamId).toBeUndefined();
  });

  it('discards retained interrupted follow-ups when the chat is cleared', async () => {
    const { ctrl } = makeInterruptedController(Promise.resolve(), true);
    await retainInterruptedFollowUp(ctrl, 'Discard me.');
    ctrl.clearInterruptedRecovery();

    expect(ctrl.admitInterruptedFollowUp({ text: 'Fresh chat.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('keeps retained follow-ups ahead of a retry after manual resume rollback', async () => {
    const snapshotStore = makeResumeSnapshotStore({
      executionId: 'exec-1',
      config: makeResumeConfig(),
      load: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('load failed')),
    });
    const { ctrl } = makeInterruptedController(
      Promise.resolve(),
      true,
      snapshotStore,
    );
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    await ctrl.resume('aaaaaa' as ExecutionId, makeResolvedResume());
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
  });

  it('preserves root ownership when auto-resuming a child stream', async () => {
    const root = 'root-stream' as StreamTabId;
    const child = 'child-stream' as StreamTabId;
    rootStreamId.set(root);
    const snapshotStore = makeResumeSnapshotStore({
      executionId: 'exec-1',
      config: makeResumeConfig(),
      parentStreamId: root,
    });
    const ctrl = createChatSessionController(makeInit({ snapshotStore }));

    await expect(ctrl.tryResumeStream(child)).resolves.toBe(true);

    expect(rootStreamId.get()).toBe(root);
    expect(mocks.notify).toHaveBeenCalledWith('agentFinished');
  });

  it('does not auto-resume after stop during helper-model setup', async () => {
    const helperModel = pDefer<void>();
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
      undefined,
    );
    expect(mocks.syncStreamLog).not.toHaveBeenCalledWith('stream-1', {
      forceFinal: true,
    });
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
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

    expect(mocks.syncStreamLog).not.toHaveBeenCalledWith('stream-1', {
      forceFinal: true,
    });
  });
});
