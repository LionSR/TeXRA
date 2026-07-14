// Unit tests for the chat-session controller's state transitions.
// Does not require actual agent execution — the controller's orchestration
// methods (startRootRun, resume) touch real agent runtime infrastructure,
// so these tests focus on the factory contract and the stop/idle state
// mutations that are safe to verify without a full agent harness.

import PQueue from 'p-queue';
import pDefer from 'p-defer';
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
  resumeQueuedToolUseSnapshot: vi.fn(),
  resumeToolUseFromSnapshot: vi.fn(),
  projectStreamTranscript: vi.fn(),
  notify: vi.fn(),
  appendLocalAssistantTranscript: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
  clearLocalTranscript: vi.fn(),
  moveLocalTranscriptToStream: vi.fn(),
  resolveCliResumeSnapshot: vi.fn(),
  followUpEnqueue: vi.fn(),
  sessionEventEmit: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: mocks.getExecutionStore,
  registerExecution: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@agent/runtime/resolveAndResumeStream', () => ({
  resolveAndResumeStream: mocks.resolveAndResumeStream,
}));

vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseSnapshot: mocks.resumeQueuedToolUseSnapshot,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: vi.fn(),
  resumeToolUseFromSnapshot: mocks.resumeToolUseFromSnapshot,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.defaultSession,
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

vi.mock('@cli/runtime/sessionResume', () => ({
  resolveCliResumeSnapshot: mocks.resolveCliResumeSnapshot,
  explainNonResumable: (
    resolution: { readonly kind: string },
    id: string,
  ): string => `not resumable (${resolution.kind}): ${id}`,
}));

import { StreamSnapshotStore } from '@transcript';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { wakeQueuedFollowUpStream } from '@agent/followUp/ToolUseFollowUp';
import type { ResumeStreamPorts } from '@agent/runtime/resolveAndResumeStream';
import type { ResumeQueuedToolUseOptions } from '@agent/runtime/resumeQueuedToolUse';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
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
  type TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<TuiSession> = {}): TuiSession {
  return {
    streamId: undefined,
    interruptedStreamId: undefined,
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

describe('CLI terminal outcome resolution', () => {
  beforeEach(() => {
    mocks.getExecutionStore.mockReset();
  });

  it('prefers the persisted post-shutdown outcome', async () => {
    mocks.getExecutionStore.mockReturnValue({
      readMeta: vi.fn().mockResolvedValue({
        outcome: RUN_OUTCOME.CANCELLED,
      }),
    });

    await expect(
      readCliRunOutcome({
        category: 'toolUse',
        executionId: 'shutdown-race',
        outcome: RUN_OUTCOME.COMPLETED,
        streamId: 'shutdown-race',
      } as Parameters<typeof readCliRunOutcome>[0]),
    ).resolves.toBe(RUN_OUTCOME.CANCELLED);
  });

  it('surfaces storage failures instead of masking them', async () => {
    mocks.getExecutionStore.mockReturnValue({
      readMeta: vi.fn().mockRejectedValue(new Error('metadata read failed')),
    });

    await expect(
      readCliRunOutcome({
        category: 'toolUse',
        executionId: 'broken-storage',
        outcome: RUN_OUTCOME.COMPLETED,
        streamId: 'broken-storage',
      } as Parameters<typeof readCliRunOutcome>[0]),
    ).rejects.toThrow('metadata read failed');
  });
});

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
    getExecutionId: vi.fn(() => options.executionId),
    readPersistedExecutionId: vi.fn(async () => options.persistedExecutionId),
    getRunConfig: vi.fn(() => options.config),
    getParentStreamId: vi.fn(() => options.parentStreamId),
  } as unknown as StreamSnapshotStore;
}

function makeResolvedResume() {
  return {
    kind: 'toolUse' as const,
    streamId: 'stream-resume' as StreamTabId,
    snapshot: { executionId: 'exec-resume' } as never,
    config: makeResumeConfig(),
  };
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
  mocks.resolveAndResumeStream.mockImplementationOnce(
    async (
      _streamId: StreamTabId,
      ports: { resumeToolUseSnapshot(snapshot: unknown): Promise<boolean> },
    ) => ports.resumeToolUseSnapshot({ version: 2 }),
  );
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
  mocks.resolveAndResumeStream.mockImplementationOnce(
    async (
      _streamId: StreamTabId,
      ports: { resumeToolUseSnapshot(snapshot: unknown): Promise<boolean> },
    ) => ports.resumeToolUseSnapshot({ version: 2 }),
  );
  const retry = ctrl.admitInterruptedFollowUp({ text: 'Retry.' });
  expect(retry.kind).toBe('accepted');
  if (retry.kind !== 'accepted') return;
  await expect(retry.completion).resolves.toBe(true);
  expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
    'stream-1',
    { version: 2 },
    expect.any(Object),
    expect.objectContaining({
      extraFollowUps: expectedTexts.map((text) => ({ text })),
    }),
  );
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
      events: { emit: mocks.sessionEventEmit },
      followUps: { enqueue: mocks.followUpEnqueue },
      status: { isActiveOrResuming: mocks.streamIsActiveOrResuming },
      executions: { stopAgentStream: mocks.stopAgentStream },
      transcripts: { ensureLoaded: vi.fn(async () => undefined) },
    });
    mocks.resolveAndResumeStream.mockReset();
    mocks.resolveAndResumeStream.mockResolvedValue(true);
    mocks.resumeQueuedToolUseSnapshot.mockReset();
    mocks.resumeQueuedToolUseSnapshot.mockImplementation(
      async (...args: unknown[]) => {
        const options = args[3] as ResumeQueuedToolUseOptions;
        options.onFollowUpQueueReady?.();
        return true;
      },
    );
    mocks.projectStreamTranscript.mockReset();
    mocks.notify.mockReset();
    mocks.appendLocalAssistantTranscript.mockReset();
    mocks.appendLocalErrorTranscript.mockReset();
    mocks.appendLocalUserTranscript.mockReset();
    mocks.clearLocalTranscript.mockReset();
    mocks.moveLocalTranscriptToStream.mockReset();
    mocks.resolveCliResumeSnapshot.mockReset();
    mocks.followUpEnqueue.mockReset();
    mocks.sessionEventEmit.mockReset();
    mocks.resumeToolUseFromSnapshot.mockReset();
    mocks.resumeToolUseFromSnapshot.mockResolvedValue({
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      executionId: 'exec-resume',
      streamId: 'stream-resume',
    });
    rootStreamId.set(undefined);
    rootRunPending.set(false);
    rootRunStreamId.set(undefined);
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

  it('reserves the root-run slot before resume() awaits the resolved snapshot', async () => {
    const snapshot = pDefer<{ readonly kind: 'not-found' }>();
    mocks.resolveCliResumeSnapshot.mockReturnValueOnce(snapshot.promise);
    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = ctrl.resume('aaaaaa' as ExecutionId);

    // The claim (tryClaimRootRunSlot) must land synchronously, before
    // resume() ever reaches its first await — same contract as
    // tryResumeStream above.
    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(ctrl.canStartRootRun()).toBe(false);

    snapshot.resolve({ kind: 'not-found' });
    await resumed;
    expect(session.runCompleted).toBe(true);
  });

  it('retains the configuration of a manually resumed conversation', async () => {
    const config = makeResumeConfig({
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflowAgentKeys: ['builtInWorkflow:physicsReviewer'],
        toolUseAgentKeys: ['builtInToolUse:orchestrator'],
      },
    });
    const ctrl = createChatSessionController(makeInit());

    await ctrl.resume('exec-resume' as ExecutionId, {
      ...makeResolvedResume(),
      config,
    });

    expect(sessionMeta.get()).toMatchObject({
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: config.delegationAgentScope,
    });
  });

  it('manual resume supersedes stale interrupted recovery state', async () => {
    const session = makeSession({
      interruptedStreamId: 'stream-interrupted' as StreamTabId,
      runCompleted: true,
      stopRequested: true,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

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
      expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
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

  it('resume() suspended on the resolved snapshot keeps a concurrent follow-up wake from also claiming the root-run slot', async () => {
    // Reproduces the finding's interleaving: resume(A) suspends on
    // resolveCliResumeSnapshot (an await-suspension point) with the slot
    // already claimed; a follow-up wake (tryResumeStream for a different
    // stream) fires while A is still suspended. Pre-fix, resume(A) checked
    // availability but claimed the slot only after this (and three more)
    // awaits, so B's tryResumeStream would see the slot as free, claim it,
    // and start doing real work — which resume(A) would then clobber when
    // it woke back up and unconditionally overwrote session.runPromise.
    // Post-fix, exactly one caller (A) ever holds the slot.
    const snapshot = pDefer<{ readonly kind: 'not-found' }>();
    mocks.resolveCliResumeSnapshot.mockReturnValueOnce(snapshot.promise);
    const session = makeSession({ runCompleted: true });
    const snapshotStoreForB = makeResumeSnapshotStore({
      executionId: undefined,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: snapshotStoreForB }),
    );

    const resumeA = ctrl.resume('aaaaaa' as ExecutionId);
    // A is now suspended inside resolveCliResumeSnapshot; the slot is
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
    snapshot.resolve({ kind: 'not-found' });
    await resumeA;
    expect(session.runCompleted).toBe(true);
  });

  it('honors a Ctrl-C issued while resume() is still rehydrating and never starts the resumed run', async () => {
    // The early slot claim makes this resume() interruptible before the resumed
    // agent actually starts running. If the user hits Ctrl-C during that
    // rehydration window, resume() must notice `session.stopRequested` and bail
    // out instead of silently starting `resumeToolUseFromSnapshot()` once the
    // awaits finish.
    const ensureLoaded = pDefer<void>();
    const base = mocks.defaultSession();
    mocks.defaultSession.mockReturnValue({
      ...base,
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

    expect(mocks.resumeToolUseFromSnapshot).not.toHaveBeenCalled();
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
    expect(mocks.resumeToolUseFromSnapshot).not.toHaveBeenCalled();
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
    } as unknown as StreamSnapshotStore;
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );
    const preResolved = makeResolvedResume();
    const { snapshot } = preResolved;
    mocks.resumeToolUseFromSnapshot.mockImplementationOnce(
      async (
        _snapshot: unknown,
        _runtimeHost: unknown,
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
      expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledWith(
        snapshot,
        expect.any(Object),
        expect.objectContaining({
          isCancellationRequested: expect.any(Function),
        }),
      ),
    );
    const resumeOptions = mocks.resumeToolUseFromSnapshot.mock.calls[0]?.[2] as
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

    await expect(
      wakeQueuedFollowUpStream(
        'child-stream',
        { status: 'queued', reason: 'waiting' },
        ctrl,
      ),
    ).resolves.toEqual({ kind: 'queued_resume_failed' });

    expect(snapshotStore.preload).not.toHaveBeenCalled();
  });

  it('allows WAITING results when auto-resuming queued tool-use snapshots', async () => {
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    patchSessionMeta({
      cliMultiAgentPresetId: 'stale-team',
      delegationAgentScope: {
        workflowAgentKeys: ['custom:stale'],
        toolUseAgentKeys: ['custom:stale'],
      },
    });
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
    mocks.resumeQueuedToolUseSnapshot.mockImplementationOnce(
      async (
        _streamId: StreamTabId,
        _snapshot: unknown,
        _runtimeHost: unknown,
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

    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      'stream-1',
      { version: 2 },
      expect.any(Object),
      expect.objectContaining({
        allowWaitingResult: true,
        isCancellationRequested: expect.any(Function),
      }),
    );
    expect(mocks.projectStreamTranscript).toHaveBeenCalledWith('stream-1', {
      finalize: true,
    });
    expect(rootStreamId.get()).toBe('stream-1');
    expect(mocks.notify).not.toHaveBeenCalledWith({ kind: 'agentFinished' });
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
      'stream-1',
      { text: 'Transfer this accepted message.' },
      { force: true },
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

    session.runCompleted = true;
    teardown.resolve();
    if (admission.kind !== 'accepted') return;
    await expect(admission.completion).resolves.toBe(true);
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      'stream-1',
      { version: 2 },
      expect.any(Object),
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

    session.runCompleted = true;
    teardown.resolve();
    await expect(first.completion).resolves.toBe(true);
    expect(mocks.resolveAndResumeStream).toHaveBeenCalledOnce();
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      'stream-1',
      { version: 2 },
      expect.any(Object),
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
    mocks.resumeQueuedToolUseSnapshot.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[3] as ResumeQueuedToolUseOptions;
        options.onFollowUpQueueReady?.();
        return resume.promise;
      },
    );

    const first = ctrl.admitInterruptedFollowUp({ text: 'Resume now.' });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') return;
    await vi.waitFor(() =>
      expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledOnce(),
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
    expect(mocks.notify).toHaveBeenCalledWith({ kind: 'agentFinished' });
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
    );
    expect(mocks.projectStreamTranscript).not.toHaveBeenCalledWith('stream-1', {
      finalize: true,
    });
    expect(mocks.notify).not.toHaveBeenCalledWith({ kind: 'agentFinished' });
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

    expect(mocks.projectStreamTranscript).not.toHaveBeenCalledWith('stream-1', {
      finalize: true,
    });
  });
});
