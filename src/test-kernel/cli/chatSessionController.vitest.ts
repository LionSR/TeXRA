// Unit tests for the chat-session controller's run-slot ownership, stop and
// resume paths, and presentation-host lifecycle. Agent run itself is
// mocked; the session surfaces the controller reasons about (run
// registry, event hub, run status, host interactions) are the real
// runtime objects wherever a test asserts through them.

import { Effect } from 'effect';
import PQueue from 'p-queue';
import pDefer from 'p-defer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  runAgent: vi.fn(),
  request: vi.fn(),
  notifyFollowUpSent: vi.fn(),
  cancelInteractions: vi.fn(),
  workspaceGet: vi.fn(),
  globalGet: vi.fn(),
  getRunRecords: vi.fn(),
  setCliHelperModel: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  presentationHostClose: vi.fn(),
  defaultSession: vi.fn(),
  getActiveRunIds: vi.fn(),
  getRunHandle: vi.fn(),
  detachHostInteractions: vi.fn(),
  attachTerminalResultToast: vi.fn(),
  createTuiHostInteractions: vi.fn(),
  resumeRun: vi.fn(),
  notify: vi.fn(),
  appendLocalAssistantTranscript: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
  clearLocalTranscript: vi.fn(),
  moveLocalTranscriptToRun: vi.fn(),
  followUpEnqueue: vi.fn(),
  followUpQueueForLease: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getRunRecords: (...args: unknown[]) => {
    const records = mocks.getRunRecords(...args);
    return {
      readRunEnd: () =>
        Effect.tryPromise({
          try: () => records.readRunEnd(),
          catch: ensureError,
        }),
      readConfig: () =>
        Effect.tryPromise({
          try: () => records.readConfig(),
          catch: ensureError,
        }),
      exists: () =>
        Effect.tryPromise({
          try: () => records.exists(),
          catch: ensureError,
        }),
    };
  },
  RunLeaseActiveError: class RunLeaseActiveError extends Error {},
}));

vi.mock('@agent/runtime/resumeRun', () => ({
  resumeRun: mocks.resumeRun,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
  ResumeSessionUnavailableError: class ResumeSessionUnavailableError extends Error {},
}));

vi.mock('@agent/runtime/runAgent', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('@agent/runtime/SessionHandle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/runtime/SessionHandle')>()),
  currentSession: mocks.defaultSession,
  defaultSession: mocks.defaultSession,
}));

vi.mock('@agent/runtime/terminalResultToast', () => ({
  attachTerminalResultToast: mocks.attachTerminalResultToast,
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

vi.mock('@cli/chat/tui/state/transcript', () => ({
  describeRequestError: (error: { reason?: string; _tag: string }) =>
    error.reason ?? error._tag,
  appendLocalAssistantTranscript: mocks.appendLocalAssistantTranscript,
  appendLocalErrorTranscript: mocks.appendLocalErrorTranscript,
  appendLocalUserTranscript: mocks.appendLocalUserTranscript,
  clearLocalTranscript: mocks.clearLocalTranscript,
  moveLocalTranscriptToRun: mocks.moveLocalTranscriptToRun,
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: mocks.notify,
}));

import {
  describeFollowUpFailure,
  type FollowUpRecoveryLease,
} from '@agent/followUp';
import type { AgentEvent } from '@agent/trace';
import type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { ResumeRunOptions } from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { readCliRunOutcomeState } from '@cli/runtime/terminalStatus';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import {
  patchSessionMeta,
  rootRunPending,
  claimedRunId,
  rootRunId,
  sessionMeta,
} from '@cli/chat/tui/state/cliState';
import { currentView } from '@cli/chat/tui/state/sessionView';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStartRootRun,
  chatTuiCanStopActiveRun,
  chatTuiIsResumableIdleOnExit,
  chatTuiSigintAction,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { DisposableStore } from '@platform/disposable';
import { RUN_OUTCOME, RUN_PHASE, type RunId } from '@shared/schemas';
import { TEXRA_APPROVAL_POLICY_DEFAULT } from '@shared/approvalPolicy';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { setupPlatform } from '@test/support/setupPlatform';
import { ensureError } from '@utils/errors/errorMessage';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';
import { bashApprovalRequest } from '../agent/progressTestUtils';

// The state stores the controller's setting reads land on, as ports of the
// installed fake host rather than a module mock of `platform()`: the setting
// path (`detachSubagentsOnStop` -> `readPlatformSetting`) resolves its stores
// through the host, and the kernel's setup file installs a host before this
// file's mocks are registered.
setupPlatform(
  {},
  {
    globalState: { get: mocks.globalGet, update: async () => {} },
    workspaceState: { get: mocks.workspaceGet, update: async () => {} },
  },
);

/**
 * Session fixture in the states the controller is exercised from. The
 * run-claim triple is owned by {@link TuiSession}, so a fixture reaches a
 * pending or completed claim through the same transitions production uses.
 */
interface SessionFixture {
  readonly runId?: RunId;
  readonly interruptedRunId?: RunId;
  readonly runPromise?: Promise<void>;
  readonly runCompleted?: boolean;
  readonly stopRequested?: boolean;
}

function makeSession(overrides: SessionFixture = {}): TuiSession {
  const session = new TuiSession();
  if (overrides.runPromise) session.markRunPending(overrides.runPromise);
  if (overrides.runCompleted) session.markRunCompleted();
  if (overrides.runId) session.runId = overrides.runId;
  session.interruptedRunId = overrides.interruptedRunId;
  session.stopRequested = overrides.stopRequested ?? false;
  return session;
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
    commandName: 'chat',
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
  runId: RunId;
  outcome: Outcome;
};

/** The subset of `executeAgent`'s options every mock implementation below reads. */
type ExecuteAgentMockOptions = {
  readonly onRunResolved?: (id: RunId) => void;
};

function makeInit(
  overrides: Partial<ChatSessionControllerInit> = {},
): ChatSessionControllerInit {
  return {
    session: makeSession(),
    runtimeSession: mocks.defaultSession(),
    getSessionContext: () => makeSessionContext(),
    disposables: new DisposableStore(),
    followUpQueue: new PQueue({ concurrency: 1 }),
    initialAgent: 'demo-agent',
    initialModel: 'demo-model',
    initialModelSource: 'builtin-default',
    cwd: '/tmp/workspace',
    getSlashCommandContext: () => {
      throw new Error('slash commands are not exercised here');
    },
    secrets: new FakeSecrets(),
    state: new FakeStateStore(),
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

/** Durable run record `resume()` resolves before adopting the run. */
function installResumeRunStore(
  config: AgentConfig = makeResumeConfig(),
  exists = true,
): void {
  mocks.getRunRecords.mockReturnValue({
    readConfig: async () => config,
    exists: async () => exists,
  });
}

/**
 * Installs what `defaultSession()` answers with. Every surface is a stub the
 * controller can call; a test that asserts through a real runtime object swaps
 * just that surface in. `defaultSession` is a bare mock, so the override map is
 * untyped here exactly as the returned session is.
 */
function installSession(overrides: Record<string, unknown> = {}): void {
  const runs = {
    getActiveIds: mocks.getActiveRunIds,
    getHandle: mocks.getRunHandle,
  };
  mocks.defaultSession.mockReturnValue({
    approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
    interactions: {
      use: vi.fn(() => mocks.detachHostInteractions),
      cancel: mocks.cancelInteractions,
    },
    requests: { request: mocks.request },
    followUps: {
      notifySent: mocks.notifyFollowUpSent,
      claimRecovery: vi.fn((runId: RunId) => ({
        runId,
        kind: 'recovery' as const,
      })),
      useRecovery: vi.fn((recovery: FollowUpRecoveryLease) => recovery),
      release: vi.fn(),
      queue: mocks.followUpQueueForLease.mockReturnValue({
        restore: mocks.followUpEnqueue,
      }),
    },
    approvals: { registerRunParent: vi.fn() },
    runs,
    transcripts: { ensureLoaded: vi.fn(() => Effect.void) },
    // The parent edge the resume path reads cold, off the same seeded view
    // the TUI renders.
    readView: () => Effect.succeed(currentView()),
    ...overrides,
  });
}

/**
 * Installs a session whose interaction, event, status, and run surfaces
 * are the real runtime objects rather than per-mock stubs.
 */
function installOwnerSession(): {
  readonly session: SessionHandle;
  readonly runs: RunRegistry;
  readonly interactions: SessionHostInteractions;
} {
  const session = createTestSession();
  // The real session's request handler admits only runs the fold holds;
  // these cases track runs directly, so the stop request lands on the
  // registry the way the handler would land it.
  const owner = Object.create(session) as SessionHandle;
  Object.defineProperty(owner, 'requests', {
    value: {
      request: (req: RuntimeRequest) =>
        Effect.gen(function* (): Effect.fn.Return<Outcome> {
          if (req.kind === 'run.stop') {
            yield* session.runs.stopAgentRun(req.runId, {
              detachActiveChildren: req.detachActiveChildren ?? undefined,
            });
          }
          return { kind: 'done' };
        }),
    },
  });
  mocks.defaultSession.mockReturnValue(owner);
  return {
    session,
    runs: session.runs,
    interactions: session.interactions,
  };
}
/**
 * A stop lands only on a run the fold holds, so a test that stops one states
 * it in the view first.
 */
function holdRun(runId: RunId): void {
  seedView(viewWith([makeRunView({ id: runId })]));
}

/** `resumeRun`'s started result: the run ran and the batch reached it. */
const STARTED = { started: true, delivered: true } as const;

const defaultResumeRun = (_runId: RunId, options: ResumeRunOptions) =>
  Effect.tryPromise({
    try: async () => {
      // The real `resumeRun` rearranges the host onto the resumed run only
      // after its own retrieval succeeded, so every stand-in that reaches a launch
      // must run the hook or the caller never adopts the run.
      if (options.onResumeResolved) await options.onResumeResolved();
      options.onFollowUpQueueReady?.({
        runId: '7e5701' as RunId,
        kind: 'recovery',
      });
      return STARTED;
    },
    catch: ensureError,
  });

function resumeWithAutoResumeData(): void {
  mocks.resumeRun.mockImplementation(defaultResumeRun);
}

function makeInterruptedController(
  runPromise: Promise<void>,
  runCompleted: boolean,
) {
  const session = makeSession({
    runId: 'a11111' as RunId,
    interruptedRunId: 'a11111' as RunId,
    runPromise,
    runCompleted,
    stopRequested: true,
  });
  resumeWithAutoResumeData();
  return {
    ctrl: createChatSessionController(makeInit({ session })),
    session,
  };
}

async function retainInterruptedFollowUp(
  ctrl: ReturnType<typeof createChatSessionController>,
  text: string,
): Promise<void> {
  mocks.resumeRun
    .mockReset()
    .mockImplementation(defaultResumeRun)
    .mockReturnValueOnce(Effect.succeed({ failed: 'not_resumable' }));
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
  expect(mocks.resumeRun).toHaveBeenCalledWith(
    'a11111',
    expect.objectContaining({
      extraFollowUps: expectedTexts.map((text) => ({ text })),
    }),
  );
}

describe('CLI terminal outcome resolution', () => {
  beforeEach(() => {
    mocks.getRunRecords.mockReset();
  });

  it('prefers the persisted post-shutdown outcome', async () => {
    mocks.getRunRecords.mockReturnValue({
      readRunEnd: vi.fn().mockResolvedValue({
        outcome: RUN_OUTCOME.CANCELLED,
      }),
    });

    await expect(
      Effect.runPromise(
        readCliRunOutcomeState(mocks.defaultSession(), {
          outcome: RUN_OUTCOME.COMPLETED,
          output: { category: 'toolUse', response: '', files: [] },
          runId: '5d0001' as RunId,
        }),
      ),
    ).resolves.toEqual({
      outcome: RUN_OUTCOME.CANCELLED,
      outcomePersisted: true,
    });
  });

  it('reports an outcome read failure and retains the completed run', async () => {
    const reportReadFailure = vi.fn();
    mocks.getRunRecords.mockReturnValue({
      readRunEnd: vi.fn().mockRejectedValue(new Error('metadata read failed')),
    });

    await expect(
      Effect.runPromise(
        readCliRunOutcomeState(
          mocks.defaultSession(),
          {
            outcome: RUN_OUTCOME.COMPLETED,
            output: { category: 'toolUse', response: '', files: [] },
            runId: 'b0f001' as RunId,
          },
          reportReadFailure,
        ),
      ),
    ).resolves.toEqual({
      outcome: RUN_OUTCOME.COMPLETED,
      outcomePersisted: false,
    });
    expect(reportReadFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message:
          'Could not verify the persisted outcome for run b0f001; using the current run outcome: metadata read failed',
        cause: expect.any(Error),
      }),
    );
  });
});

describe('createChatSessionController', () => {
  beforeAll(bindTestSessionView);
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();

    mocks.executeAgent.mockResolvedValue({
      category: 'toolUse',
      runId: 'e50001',
      outcome: RUN_OUTCOME.COMPLETED,
    });
    mocks.runAgent.mockImplementation(
      (request: { config: unknown; runId: RunId }, options: object) =>
        Effect.tryPromise({
          try: () => mocks.executeAgent(request.config, request.runId, options),
          catch: ensureError,
        }),
    );
    // Return the caller-provided default (undefined for roster keys) — a
    // blanket `false` is not a valid persisted value for
    // AGENT_ROSTER_SELECTION, which agent resolution now reads.
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
    mocks.getActiveRunIds.mockReturnValue([]);
    mocks.attachTerminalResultToast.mockReturnValue(vi.fn());
    mocks.createTuiHostInteractions.mockReturnValue({});
    mocks.request.mockImplementation(() =>
      Effect.succeed<Outcome>({ kind: 'done' }),
    );
    installSession();
    mocks.resumeRun.mockImplementation(defaultResumeRun);
    installResumeRunStore();
    seedView(viewWith([]));
    rootRunId.set(undefined);
    rootRunPending.set(false);
    claimedRunId.set(undefined);
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

  it('reads the shared detach-subagents setting key when stopping an active run', () => {
    const session = makeSession({
      runId: 'a11111' as RunId,
    });
    holdRun('a11111' as RunId);
    const ctrl = createChatSessionController(makeInit({ session }));

    mocks.globalGet.mockReturnValue(true);
    ctrl.stop();

    expect(mocks.globalGet).toHaveBeenCalledWith(
      GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    );
    expect(mocks.request).toHaveBeenCalledWith({
      kind: 'run.stop',
      runId: 'a11111',
      detachActiveChildren: true,
    });
  });

  it('stops the focused root while preserving its agent children', () => {
    const session = makeSession({
      runId: 'b00001' as RunId,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stopRun('b00001' as RunId);

    expect(session.stopRequested).toBe(true);
    expect(session.interruptedRunId).toBe('b00001');
    expect(mocks.cancelInteractions).toHaveBeenCalledWith({
      runId: 'b00001',
      cause: 'Run interrupted.',
    });
    expect(mocks.request).toHaveBeenCalledWith({
      kind: 'run.stop',
      runId: 'b00001',
      detachActiveChildren: true,
    });
    expect(mocks.workspaceGet).not.toHaveBeenCalled();
  });

  it('stops one focused child without stopping the root session', () => {
    const session = makeSession({
      runId: 'b00001' as RunId,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stopRun('ca0001' as RunId);

    expect(session.stopRequested).toBe(false);
    expect(session.interruptedRunId).toBeUndefined();
    expect(mocks.cancelInteractions).toHaveBeenCalledWith({
      runId: 'ca0001',
      cause: 'Run interrupted.',
    });
    expect(mocks.request).toHaveBeenCalledWith({
      kind: 'run.stop',
      runId: 'ca0001',
      detachActiveChildren: true,
    });
  });

  it('keeps detached-child approvals answerable after the stopped root finalizes', async () => {
    const childRun = 'c00001' as RunId;
    const { runs, interactions } = installOwnerSession();
    const adapterDecision = pDefer<{ action: 'approve' | 'reject' }>();
    const requestBashApproval = vi.fn(() => adapterDecision.promise);
    const disposeAdapter = vi.fn();
    const detachResultToast = vi.fn();
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

    const rootRunResult =
      pDefer<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
    // The launch mints the root run id, so the fixture takes it from the
    // launch instead of naming one of its own.
    mocks.executeAgent.mockImplementationOnce(
      async (
        _config: unknown,
        runId: RunId,
        options: ExecuteAgentMockOptions,
      ) => {
        const rootHandle = testRunHandle({
          runId,
          parent: null,
          agent: 'root',
        });
        const childHandle = testRunHandle({
          runId: childRun,
          parent: runId,
          agent: 'child',
        });
        rootHandle.attachInterruptHandler({
          interrupt: () => {
            runs.untrack(runId);
            rootRunResult.resolve({
              category: 'toolUse',
              runId,
              outcome: RUN_OUTCOME.CANCELLED,
            });
          },
        });
        runs.trackAgentRun(rootHandle, {
          status: RUN_PHASE.RUNNING,
        });
        runs.trackAgentRun(childHandle, {
          status: RUN_PHASE.RUNNING,
        });
        options.onRunResolved?.(runId);
        return rootRunResult.promise;
      },
    );

    const session = makeSession();
    const disposables = new DisposableStore();
    const ctrl = createChatSessionController(
      makeInit({ session, disposables }),
    );
    ctrl.startRootRun(makeRunRequest('Delegate the calculation.'));
    const rootRun = session.runId;
    if (!rootRun) throw new Error('startRootRun did not claim a run id');
    await vi.waitFor(() => expect(runs.getHandle(childRun)).toBeDefined());

    ctrl.stopRun(rootRun);
    await session.runPromise;

    expect(session.runCompleted).toBe(true);
    expect(runs.getHandle(childRun)?.isChild).toBe(false);
    expect(disposeAdapter).not.toHaveBeenCalled();
    expect(detachResultToast).toHaveBeenCalledOnce();
    expect(mocks.presentationHostClose).not.toHaveBeenCalled();

    const approval = interactions.requestBashApproval(
      bashApprovalRequest({
        command: 'printf child',
        runId: childRun,
      }),
    );
    await vi.waitFor(() => expect(requestBashApproval).toHaveBeenCalledOnce());
    adapterDecision.resolve({ action: 'approve' });
    await expect(approval).resolves.toEqual({ action: 'approve' });

    // The host lives for the chat session, not for the runs it served.
    runs.untrack(childRun);
    expect(disposeAdapter).not.toHaveBeenCalled();

    disposables.dispose();
    expect(disposeAdapter).toHaveBeenCalledOnce();
    expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
    runs.dispose();
  });

  it('does not overlap terminal-result presenters across root launches', async () => {
    const hostA = { emit: vi.fn() };
    const hostB = { emit: vi.fn() };
    const resultPresenters = new Set<(message: string) => void>();
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
      .mockReturnValueOnce(
        Effect.tryPromise({ try: () => runA.promise, catch: ensureError }),
      )
      .mockReturnValueOnce(
        Effect.tryPromise({ try: () => runB.promise, catch: ensureError }),
      );

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    const config = makeRunRequest('Check presenter ownership.');
    ctrl.startRootRun(config);
    session.runId = 'a0000a' as RunId;
    ctrl.stopRun('a0000a' as RunId);
    for (const present of resultPresenters) present('Failure A');
    runA.resolve({
      category: 'toolUse',
      outcome: RUN_OUTCOME.CANCELLED,
      runId: 'a0000a' as RunId,
    });
    await session.runPromise;

    expect(resultPresenters).toHaveLength(0);

    ctrl.startRootRun(config);
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(2));
    expect(mocks.attachTerminalResultToast).toHaveBeenCalledTimes(2);
    expect(session.runCompleted).toBe(false);
    await vi.waitFor(() => expect(resultPresenters).toHaveLength(1));
    for (const present of resultPresenters) present('Failure B');
    runB.resolve({
      category: 'toolUse',
      outcome: RUN_OUTCOME.FAILED,
      runId: 'b0000b' as RunId,
    });
    await session.runPromise;

    expect(hostA.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message: 'Failure A',
    });
    expect(hostB.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
      message: 'Failure B',
    });
    expect(resultPresenters).toHaveLength(0);
  });

  it('reports a fresh-run defect and settles its claimed run slot', async () => {
    mocks.runAgent.mockReturnValueOnce(Effect.die(new Error('launch defect')));
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.startRootRun(makeRunRequest('Check launch failure.'));

    await expect(session.runPromise).resolves.toBeUndefined();
    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'launch defect',
    );
    expect(session.runCompleted).toBe(true);
  });

  it('reserves the root-run slot before tryResumeRun awaits persisted state', async () => {
    const configRead = pDefer<null>();
    const session = makeSession({ runCompleted: true });
    // Nothing persisted for the run: the resume gives the slot back once the
    // durable read it waited on resolves.
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      exists: async () => false,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = ctrl.tryResumeRun('a11111' as RunId);

    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);

    configRead.resolve(null);
    await expect(resumed).resolves.toBe(false);
    expect(session.runCompleted).toBe(true);
  });

  it('reserves the root-run slot before resume() awaits the resolution', async () => {
    const configRead = pDefer<null>();
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      exists: async () => false,
    });
    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = ctrl.resume('aaaaaa' as RunId);

    // The claim (tryClaimRootRunSlot) must land synchronously, before
    // resume() ever reaches its first await — same contract as
    // tryResumeRun above.
    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);

    configRead.resolve(null);
    await resumed;
    expect(session.runCompleted).toBe(true);
  });

  it('retains the configuration of a manually resumed conversation', async () => {
    const config = makeResumeConfig({
      cli: { multiAgentPresetId: 'physicist' },
      delegationAgentScope: {
        workflow: ['builtInWorkflow:physicsReviewer'],
        toolUse: ['builtInToolUse:orchestrator'],
      },
    });
    installResumeRunStore(config);
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));

    await ctrl.resume('ec0001' as RunId);
    await session.runPromise;

    expect(sessionMeta.get()).toMatchObject({
      teamName: 'Physicist',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: config.delegationAgentScope,
    });
  });

  it.each(['unusable_checkpoint', 'owned_elsewhere'] as const)(
    'refuses %s without changing the visible conversation or its configuration',
    async (failure) => {
      const session = makeSession();
      patchSessionMeta({
        agent: 'current-agent',
        model: 'current-model',
        modelSource: 'explicit-override',
        teamName: 'Mathematician',
        cliMultiAgentPresetId: 'mathematician',
        delegationAgentScope: {
          workflow: ['custom:current'],
          toolUse: ['custom:current'],
        },
      });
      const previousMetadata = sessionMeta.get();
      installResumeRunStore(
        makeResumeConfig({ cli: { multiAgentPresetId: 'physicist' } }),
      );
      // Both runtime refusals precede the hook that adopts the target run.
      mocks.resumeRun.mockReturnValueOnce(Effect.succeed({ failed: failure }));
      const ctrl = createChatSessionController(makeInit({ session }));

      await ctrl.resume('ec0001' as RunId);
      await session.runPromise;

      expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
        describeFollowUpFailure(failure),
      );
      expect(sessionMeta.get()).toEqual(previousMetadata);
      expect(mocks.setCliHelperModel).not.toHaveBeenCalled();
      expect(mocks.clearLocalTranscript).not.toHaveBeenCalled();
      expect(session.runId).toBeUndefined();
      expect(rootRunId.get()).toBeUndefined();
      expect(session.runCompleted).toBe(true);
    },
  );

  it('treats a manually resumed subagent returning to WAITING as a successful turn', async () => {
    const session = makeSession({ runCompleted: true });
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () => {
            await options.onResumeResolved?.();
            return { ...STARTED, outcome: RUN_PHASE.WAITING };
          },
          catch: ensureError,
        }),
    );
    // A fake store, like every other resume test: the real store against
    // this harness's storage-less platform now fails loudly (KVStore no
    // longer converts I/O errors into misses), which resume() treats as a
    // rehydration failure by contract.
    const init = makeInit({ session });
    const ctrl = createChatSessionController(init);

    await ctrl.resume('ec0001' as RunId);
    await session.runPromise;

    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
  });

  it('manual resume supersedes stale interrupted recovery state', async () => {
    const session = makeSession({
      interruptedRunId: 'e11111' as RunId,
      runCompleted: true,
      stopRequested: true,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    await ctrl.resume('aaaaaa' as RunId);
    await session.runPromise;

    expect(session.runId).toBe('aaaaaa');
    expect(session.interruptedRunId).toBeUndefined();
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

    const manualResume = ctrl.resume('aaaaaa' as RunId);
    teardown.resolve();

    await manualResume;
    await expect(admission.completion).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(mocks.resumeRun).toHaveBeenCalledWith(
        'aaaaaa',
        expect.objectContaining({
          extraFollowUps: [{ text: 'Preserve this accepted message.' }],
        }),
      ),
    );
  });

  it('resume() suspended on the resolution keeps a concurrent follow-up wake from also claiming the root-run slot', async () => {
    // resume(A) suspends on the config read (an await-suspension point)
    // with the slot already claimed; a follow-up wake (tryResumeRun for a
    // different run) fires while A is still suspended. Exactly one caller
    // (A) holds the slot end to end, so B must bail out rather than claim it
    // and start work that A would clobber on waking.
    const configRead = pDefer<null>();
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      exists: async () => false,
    });
    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumeA = ctrl.resume('aaaaaa' as RunId);
    // A is now suspended inside the config read; the slot is
    // already claimed.
    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);

    // The follow-up wake for a different run fires while A is still
    // suspended. It must bail out synchronously, before reading anything,
    // because the slot is already held.
    const resumedB = ctrl.tryResumeRun('ab2222' as RunId);
    expect(mocks.resumeRun).not.toHaveBeenCalled();
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
    // out instead of silently starting the resumed run once the
    // awaits finish.
    const ensureLoaded = pDefer<void>();
    installSession({
      transcripts: {
        ensureLoaded: () => Effect.promise(() => ensureLoaded.promise),
      },
    });

    const session = makeSession({
      interruptedRunId: 'e11111' as RunId,
      runCompleted: true,
    });
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () => {
            await options.onResumeResolved?.();
            return options.isCancellationRequested?.()
              ? { failed: 'not_resumable' as const }
              : STARTED;
          },
          catch: ensureError,
        }),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    holdRun('aaaaaa' as RunId);
    const resumed = ctrl.resume('aaaaaa' as RunId);
    // resume() has claimed the slot synchronously; once the durable record
    // resolves it suspends inside defaultSession().transcripts.ensureLoaded()
    // with session.runId already set to the resumed run.
    expect(session.runPromise).toBeDefined();
    await vi.waitFor(() => expect(session.runId).toBe('aaaaaa'));
    // #8273 regression: the controller must publish the run facts so status
    // rendering can derive the Ctrl-C hint from signals instead of calling
    // impure session closures that memoized renders cache stale.
    expect(rootRunPending.get()).toBe(true);
    expect(claimedRunId.get()).toBe('aaaaaa');

    const canInterruptActiveRun = chatTuiCanInterruptActiveRun(session);
    const canStopActiveRun = chatTuiCanStopActiveRun({
      runPending: Boolean(session.runPromise && !session.runCompleted),
      runId: session.runId,
      status: RUN_PHASE.WAITING,
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
    await session.runPromise;

    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedRunId).toBe('aaaaaa');
  });

  it('marks the resumed run, not the previous one, for a Ctrl-C issued before adoption', async () => {
    // The synchronous slot claim drops the pre-resume run, so a stop in the
    // window before `onResumeResolved` has no run to mark: without the
    // re-read at adoption the user's Ctrl-C would leave no recoverable
    // conversation, and any stale run it did find would be the wrong one.
    const resumeReached = pDefer<void>();
    const session = makeSession({
      runId: 'd00001' as RunId,
      runCompleted: true,
    });
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () => {
            await resumeReached.promise;
            await options.onResumeResolved?.();
            return options.isCancellationRequested?.()
              ? { failed: 'not_resumable' as const }
              : STARTED;
          },
          catch: ensureError,
        }),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    holdRun('aaaaaa' as RunId);
    const resumed = ctrl.resume('aaaaaa' as RunId);
    await vi.waitFor(() => expect(mocks.resumeRun).toHaveBeenCalledOnce());
    ctrl.stop();
    expect(session.interruptedRunId).toBeUndefined();

    resumeReached.resolve();
    await resumed;
    await session.runPromise;

    expect(session.interruptedRunId).toBe('aaaaaa');
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'run.stop',
        runId: 'd00001',
      }),
    );
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
  });

  it('reports resume rehydration failures without rejecting the TUI submit path', async () => {
    const session = makeSession({
      interruptedRunId: 'e11111' as RunId,
      runCompleted: true,
    });
    mocks.setCliHelperModel.mockRejectedValueOnce(
      new Error('rehydration failed'),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    await expect(ctrl.resume('aaaaaa' as RunId)).resolves.toBeUndefined();
    await session.runPromise;

    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'rehydration failed',
    );
    expect(session.runExitCode).toBe(CliExitCode.AgentError);
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedRunId).toBe('e11111');
    expect(chatTuiCanStartRootRun(session)).toBe(true);
  });

  it('forwards a stop issued during manual resume helper-model setup', async () => {
    const helperModel = pDefer<void>();
    mocks.setCliHelperModel.mockReturnValueOnce(helperModel.promise);

    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () => {
            await options.onResumeResolved?.();
            return {
              ...STARTED,
              outcome: options.isCancellationRequested?.()
                ? RUN_OUTCOME.CANCELLED
                : RUN_OUTCOME.COMPLETED,
            };
          },
          catch: ensureError,
        }),
    );

    const resumeStarted = ctrl.resume('aaaaaa' as RunId);
    await vi.waitFor(() =>
      expect(mocks.setCliHelperModel).toHaveBeenCalledWith('demo-model'),
    );

    ctrl.stop();
    helperModel.resolve(undefined);

    await resumeStarted;
    await vi.waitFor(() =>
      expect(mocks.resumeRun).toHaveBeenCalledWith(
        'aaaaaa',
        expect.objectContaining({
          isCancellationRequested: expect.any(Function),
        }),
      ),
    );
    const resumeOptions = mocks.resumeRun.mock.calls[0]?.[1] as
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
    const ctrl = createChatSessionController(makeInit({ session }));

    await expect(ctrl.tryResumeRun('c00001' as RunId)).resolves.toBe(false);

    expect(mocks.resumeRun).not.toHaveBeenCalled();
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
    mocks.resumeRun.mockImplementationOnce(() =>
      Effect.tryPromise({
        try: async () => ({
          ...STARTED,
          outcome: RUN_PHASE.WAITING,
        }),
        catch: ensureError,
      }),
    );
    const init = makeInit({ session });
    const ctrl = createChatSessionController(init);

    await expect(ctrl.tryResumeRun('a11111' as RunId)).resolves.toBe(true);

    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'a11111',
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
    const resumeOptions = mocks.resumeRun.mock.calls[0]?.[1] as
      ResumeRunOptions | undefined;
    expect(resumeOptions?.isCancellationRequested?.()).toBe(false);
    session.stopRequested = true;
    expect(resumeOptions?.isCancellationRequested?.()).toBe(true);
    expect(rootRunId.get()).toBe('a11111');
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
    expect(sessionMeta.get().cliMultiAgentPresetId).toBeUndefined();
    expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
  });

  it('keeps an automatic resume cancelled after clear resets session state', async () => {
    const leaseCheckStarted = pDefer<void>();
    const releaseLeaseCheck = pDefer<void>();
    const session = makeSession({ runCompleted: true });
    let resumeOptions: ResumeRunOptions | undefined;
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () => {
            resumeOptions = options;
            leaseCheckStarted.resolve();
            await releaseLeaseCheck.promise;
            return options.isCancellationRequested?.()
              ? { failed: 'not_resumable' as const }
              : STARTED;
          },
          catch: ensureError,
        }),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    const resume = ctrl.tryResumeRun('a11111' as RunId, {
      runId: 'a11111' as RunId,
      kind: 'recovery',
    });
    await leaseCheckStarted.promise;

    ctrl.stop();
    session.clearRunState();
    expect(session.stopRequested).toBe(false);
    expect(resumeOptions?.isCancellationRequested?.()).toBe(true);

    releaseLeaseCheck.resolve();
    await expect(resume).resolves.toBe(false);
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
  });

  it('launcher resume supersedes stale interrupted recovery state', async () => {
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
    );

    await expect(ctrl.tryResumeRun('a11111' as RunId)).resolves.toBe(true);

    expect(session.interruptedRunId).toBeUndefined();
    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('rejects recovery only until the interrupted run promise settles', async () => {
    const teardown = pDefer<void>();
    const session = makeSession({
      runId: 'a11111' as RunId,
      runPromise: teardown.promise,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stop();
    // Root finalization publishes slot availability before its promise has
    // completely settled.
    session.markRunCompleted();
    // `/clear` may reset the mutable session state while the interrupted
    // promise is still settling. The captured promise must remain the guard.
    session.clearRunState();

    await expect(
      ctrl.tryResumeRun('a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(false);

    expect(session.stopRequested).toBe(false);
    expect(mocks.resumeRun).not.toHaveBeenCalled();

    teardown.resolve();
    await teardown.promise;
    resumeWithAutoResumeData();

    await expect(
      ctrl.tryResumeRun('a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(true);

    expect(mocks.resumeRun).toHaveBeenCalledOnce();
  });

  it('retains every unsettled interrupted-run recovery blocker', async () => {
    const firstTeardown = pDefer<void>();
    const secondTeardown = pDefer<void>();
    const session = makeSession({
      runId: 'a11111' as RunId,
      runPromise: firstTeardown.promise,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stop();
    session.markRunCompleted();
    session.clearRunState();

    session.markRunPending(secondTeardown.promise);
    session.runId = 'a22222' as RunId;
    ctrl.stop();
    session.markRunCompleted();
    session.clearRunState();

    secondTeardown.resolve();
    await secondTeardown.promise;
    await expect(
      ctrl.tryResumeRun('a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(false);

    firstTeardown.resolve();
    await firstTeardown.promise;
    resumeWithAutoResumeData();
    await expect(
      ctrl.tryResumeRun('a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(true);

    expect(mocks.resumeRun).toHaveBeenCalledOnce();
  });

  it('transfers an admitted interruption batch to launcher resume', async () => {
    const teardown = pDefer<void>();
    const { ctrl } = makeInterruptedController(teardown.promise, true);
    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Transfer this accepted message.',
    });
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') return;

    const launcherResume = ctrl.tryResumeRun('a11111' as RunId);
    teardown.resolve();

    await expect(launcherResume).resolves.toBe(true);
    await expect(admission.completion).resolves.toBe(true);
    expect(mocks.followUpQueueForLease).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'recovery' }),
    );
    expect(mocks.followUpEnqueue).toHaveBeenCalledWith([
      { text: 'Transfer this accepted message.' },
    ]);
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
    expect(mocks.resumeRun).not.toHaveBeenCalled();

    session.markRunCompleted();
    teardown.resolve();
    if (admission.kind !== 'accepted') return;
    await expect(admission.completion).resolves.toBe(true);
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'a11111',
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
    expect(mocks.resumeRun).toHaveBeenCalledOnce();
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'a11111',
      expect.objectContaining({
        extraFollowUps: [
          { text: 'First message.' },
          { text: 'Second message.' },
        ],
      }),
    );
  });

  it('stops batching once ordinary follow-up routing is ready', async () => {
    const resume = pDefer<typeof STARTED>();
    const { ctrl } = makeInterruptedController(Promise.resolve(), true);
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () => {
            options.onFollowUpQueueReady?.({
              runId: '7e5701' as RunId,
              kind: 'recovery',
            });
            return resume.promise;
          },
          catch: ensureError,
        }),
    );

    const first = ctrl.admitInterruptedFollowUp({ text: 'Resume now.' });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') return;
    await vi.waitFor(() => expect(mocks.resumeRun).toHaveBeenCalledOnce());

    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
    resume.resolve(STARTED);
    await expect(first.completion).resolves.toBe(true);
  });

  it('retains the interrupted conversation after a failed resume', async () => {
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
    );
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    expect(session.interruptedRunId).toBe('a11111');
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
    expect(session.interruptedRunId).toBeUndefined();
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
    mocks.setCliHelperModel.mockRejectedValueOnce(new Error('load failed'));
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
    );
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    await ctrl.resume('aaaaaa' as RunId);
    // The rollback rides the run chain now that the rehydration runs inside
    // `resumeRun`'s adoption hook, so the retry follows the settled resume.
    await session.runPromise;
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
  });

  it('keeps the seeded batch when manual resume is refused', async () => {
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
    );
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    // A refusal that never reaches the follow-up queue hands the seeded batch
    // back; nothing else owns it, so the resume must put it and the
    // interrupted run back or the input typed during the interruption is
    // lost.
    mocks.resumeRun
      .mockReset()
      .mockReturnValueOnce(Effect.succeed({ failed: 'not_resumable' }));

    await ctrl.resume('aaaaaa' as RunId);

    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'aaaaaa',
      expect.objectContaining({
        extraFollowUps: [{ text: 'First attempt.' }],
      }),
    );
    await vi.waitFor(() => expect(session.interruptedRunId).toBe('a11111'));
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
  });

  it('preserves root ownership when auto-resuming a child run', async () => {
    const root = 'b00001' as RunId;
    const child = 'c00001' as RunId;
    rootRunId.set(root);
    seedView(
      viewWith([
        makeRunView({ id: root }),
        makeRunView({ id: child, parentId: root }),
      ]),
    );
    const ctrl = createChatSessionController(makeInit());

    await expect(ctrl.tryResumeRun(child)).resolves.toBe(true);

    expect(rootRunId.get()).toBe(root);
    expect(mocks.notify).toHaveBeenCalledWith('agentFinished');
  });

  it('does not auto-resume after stop during helper-model setup', async () => {
    const helperModel = pDefer<void>();
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    mocks.setCliHelperModel.mockReturnValueOnce(helperModel.promise);
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.tryPromise({
          try: async () =>
            options.isCancellationRequested?.() === true
              ? { failed: 'not_resumable' as const }
              : STARTED,
          catch: ensureError,
        }),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = ctrl.tryResumeRun('a11111' as RunId);
    await vi.waitFor(() =>
      expect(mocks.setCliHelperModel).toHaveBeenCalledWith(config.model),
    );
    ctrl.stop();
    helperModel.resolve(undefined);

    await expect(resumed).resolves.toBe(false);
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'a11111',
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
  });
});
