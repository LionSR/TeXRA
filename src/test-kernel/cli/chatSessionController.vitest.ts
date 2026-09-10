// Unit tests for the chat-session controller's run-slot ownership, stop and
// resume paths, and presentation-host lifecycle. Agent run itself is
// mocked; the session surfaces the controller reasons about (run
// registry, event hub, stream status, host interactions) are the real
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
  addRunRegistrationListener: vi.fn(),
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
      readMeta: () =>
        Effect.tryPromise({
          try: () => records.readMeta(),
          catch: ensureError,
        }),
      readConfig: () =>
        Effect.tryPromise({
          try: () => records.readConfig(),
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
import { RunInteractionOwnership } from '@agent/runtime/runInteractionOwnership';
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
  rootRunId,
  rootRunId,
  sessionMeta,
} from '@cli/chat/tui/state/cliState';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStartRootRun,
  chatTuiCanStopActiveRun,
  chatTuiIsResumableIdleOnExit,
  chatTuiSigintAction,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { DisposableStore } from '@platform/disposable';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  type RunId,
} from '@shared/schemas';
import { TEXRA_APPROVAL_POLICY_DEFAULT } from '@shared/approvalPolicy';
import { DatabaseReadFailed } from '@shared/session/database';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { RunSnapshotStore } from '@transcript';
import { ensureError } from '@utils/errors/errorMessage';
import { bindTestSessionView } from './fixtures/sessionViewFixture';
import { bashApprovalRequest } from '../agent/progressTestUtils';

/**
 * Session fixture in the states the controller is exercised from. The
 * run-claim triple is owned by {@link TuiSession}, so a fixture reaches a
 * pending or completed claim through the same transitions production uses.
 */
interface SessionFixture {
  readonly runId?: RunId;
  readonly interruptedRunId?: RunId;
  readonly runId?: string;
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
  session.runId = overrides.runId;
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
  runId: RunId;
};

/** The subset of `executeAgent`'s options every mock implementation below reads. */
type ExecuteAgentMockOptions = {
  readonly onStreamResolved?: (id: RunId) => void;
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
    snapshotStore: makeResumeSnapshotStore({}),
    initialAgent: 'demo-agent',
    initialModel: 'demo-model',
    initialModelSource: 'builtin-default',
    cwd: '/tmp/workspace',
    getSlashCommandContext: () => {
      throw new Error('slash commands are not exercised here');
    },
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
  readonly runId?: string | undefined;
  readonly config?: AgentConfig | undefined;
  readonly parentRunId?: RunId | undefined;
}): RunSnapshotStore {
  return {
    preload: vi.fn(() =>
      options.preload
        ? Effect.tryPromise({
            try: options.preload,
            catch: (cause) =>
              new DatabaseReadFailed({ path: ':memory:', cause }),
          })
        : Effect.void,
    ),
    load: vi.fn(() =>
      options.load
        ? Effect.tryPromise({
            try: options.load,
            catch: (cause) =>
              new DatabaseReadFailed({ path: ':memory:', cause }),
          })
        : Effect.void,
    ),
    read: vi.fn(() =>
      Effect.succeed({
        runUsage: {},
        todos: [],
        plan: undefined,
      }),
    ),
    getRunMetadata: vi.fn(() => ({
      runId: options.runId,
      config: options.config,
      identity: options.config
        ? { kind: 'agent' as const, agent: options.config.agent }
        : undefined,
    })),
    getParentRunId: vi.fn(() => options.parentRunId),
  } as unknown as RunSnapshotStore;
}

/** Durable run record `resume()` resolves before adopting the stream. */
function installResumeRunStore(
  config: AgentConfig = makeResumeConfig(),
  runId: RunId | undefined = 'stream-resume' as RunId,
): void {
  mocks.getRunRecords.mockReturnValue({
    readConfig: async () => config,
    readMeta: async () => (runId ? { runId } : null),
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
    getActiveIds: mocks.getActiveRunIds,
    getHandle: mocks.getRunHandle,
    addRegistrationListener: mocks.addRunRegistrationListener,
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
    executions: {
      ...runs,
      // The stubbed registry still answers the surfaces the real ownership
      // index reads, so the controller runs against real ownership.
      interactionOwnership: new RunInteractionOwnership(
        executions as unknown as RunRegistry,
      ),
    },
    transcripts: { ensureLoaded: vi.fn(() => Effect.void) },
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
  // these cases track executions directly, so the stop request lands on the
  // registry the way the handler would land it.
  const owner = Object.create(session) as SessionHandle;
  Object.defineProperty(owner, 'requests', {
    value: {
      request: (req: RuntimeRequest) =>
        Effect.gen(function* (): Effect.fn.Return<Outcome> {
          if (req.kind === 'stream.stop') {
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
    executions: session.runs,
    interactions: session.interactions,
  };
}
function trackLiveRun(
  runs: RunRegistry,
  runId: string,
  parentRunId: RunId,
  runId: RunId,
  agent: string,
): void {
  runs.trackAgentRun(
    testRunHandle({
      runId,
      parentRunId,
      childRunId: runId,
      agent,
    }),
    { status: RUN_PHASE.RUNNING },
  );
}

/** `resumeRun`'s started result: the run ran and the batch reached it. */
const STARTED = { started: true, delivered: true } as const;

const defaultResumeRun = (
  _runId: RunId,
  options: ResumeRunOptions,
) =>
  Effect.tryPromise({
    try: async () => {
      // The real `resumeRun` rearranges the host onto the resumed stream only
      // after its own retrieval succeeded, so every stand-in that reaches a launch
      // must run the hook or the caller never adopts the stream.
      if (options.onResumeResolved) await options.onResumeResolved();
      options.onFollowUpQueueReady?.({
        runId: 'stream:test' as RunId,
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
  snapshotStore = makeResumeSnapshotStore({
    runId: 'exec-1',
    config: makeResumeConfig(),
  }),
) {
  const session = makeSession({
    runId: 'stream-1' as RunId,
    interruptedRunId: 'stream-1' as RunId,
    runId: 'exec-1',
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
    'exec-1',
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
      readMeta: vi.fn().mockResolvedValue({
        outcome: RUN_OUTCOME.CANCELLED,
      }),
    });

    await expect(
      Effect.runPromise(
        readCliRunOutcomeState(mocks.defaultSession(), {
          category: 'toolUse',
          runId: 'shutdown-race',
          outcome: RUN_OUTCOME.COMPLETED,
          runId: 'shutdown-race',
        } as Parameters<typeof readCliRunOutcomeState>[1]),
      ),
    ).resolves.toEqual({
      outcome: RUN_OUTCOME.CANCELLED,
      outcomePersisted: true,
    });
  });

  it('reports an outcome read failure and retains the completed run', async () => {
    const reportReadFailure = vi.fn();
    mocks.getRunRecords.mockReturnValue({
      readMeta: vi.fn().mockRejectedValue(new Error('metadata read failed')),
    });

    await expect(
      Effect.runPromise(
        readCliRunOutcomeState(
          mocks.defaultSession(),
          {
            category: 'toolUse',
            runId: 'broken-storage',
            outcome: RUN_OUTCOME.COMPLETED,
            runId: 'broken-storage',
          } as Parameters<typeof readCliRunOutcomeState>[1],
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
          'Could not verify the persisted outcome for run broken-storage; using the current run outcome: metadata read failed',
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
      runId: 'exec-start',
      outcome: RUN_OUTCOME.COMPLETED,
      runId: 'stream-start',
    });
    mocks.runAgent.mockImplementation(
      (
        request: { config: unknown; runId: RunId },
        options: object,
      ) =>
        Effect.tryPromise({
          try: () =>
            mocks.executeAgent(request.config, request.runId, options),
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
    mocks.addRunRegistrationListener.mockReturnValue(vi.fn());
    mocks.attachTerminalResultToast.mockReturnValue(vi.fn());
    mocks.createTuiHostInteractions.mockReturnValue({});
    mocks.request.mockImplementation(() =>
      Effect.succeed<Outcome>({ kind: 'done' }),
    );
    installSession();
    mocks.resumeRun.mockImplementation(defaultResumeRun);
    installResumeRunStore();
    rootRunId.set(undefined);
    rootRunPending.set(false);
    rootRunId.set(undefined);
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
        _runId: unknown,
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

  it('reads the shared detach-subagents setting key when stopping an active stream', () => {
    const session = makeSession({
      runId: 'stream-1',
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    mocks.globalGet.mockReturnValue(true);
    ctrl.stop();

    expect(mocks.globalGet).toHaveBeenCalledWith(
      GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    );
    expect(mocks.request).toHaveBeenCalledWith({
      kind: 'stream.stop',
      runId: 'stream-1',
      detachActiveChildren: true,
    });
  });

  it('stops the focused root while preserving its agent children', () => {
    const session = makeSession({
      runId: 'root-stream',
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stopRun('root-stream');

    expect(session.stopRequested).toBe(true);
    expect(session.interruptedRunId).toBe('root-stream');
    expect(mocks.cancelInteractions).toHaveBeenCalledWith({
      runId: 'root-stream',
      cause: 'Run interrupted.',
    });
    expect(mocks.request).toHaveBeenCalledWith({
      kind: 'stream.stop',
      runId: 'root-stream',
      detachActiveChildren: true,
    });
    expect(mocks.workspaceGet).not.toHaveBeenCalled();
  });

  it('stops one focused child without stopping the root session', () => {
    const session = makeSession({
      runId: 'root-stream',
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stopRun('child-a');

    expect(session.stopRequested).toBe(false);
    expect(session.interruptedRunId).toBeUndefined();
    expect(mocks.cancelInteractions).toHaveBeenCalledWith({
      runId: 'child-a',
      cause: 'Run interrupted.',
    });
    expect(mocks.request).toHaveBeenCalledWith({
      kind: 'stream.stop',
      runId: 'child-a',
      detachActiveChildren: true,
    });
  });

  it('releases every live interaction owner when one release fails', () => {
    const firstFailure = new Error('first ownership release failed');
    const firstRelease = vi.fn(() => {
      throw firstFailure;
    });
    const secondRelease = vi.fn();
    const scopes = [firstRelease, secondRelease].map((release) => ({
      claim: vi.fn(),
      finish: vi.fn(),
      release,
    }));
    const runtimeSession = mocks.defaultSession();
    const open = vi
      .fn()
      .mockReturnValueOnce(scopes[0])
      .mockReturnValueOnce(scopes[1]);
    const disposables = new DisposableStore();
    const ctrl = createChatSessionController(
      makeInit({
        disposables,
        runtimeSession: {
          ...runtimeSession,
          executions: {
            ...runtimeSession.runs,
            interactionOwnership: { open },
          },
        } as SessionHandle,
      }),
    );
    const never = pDefer<never>();
    mocks.executeAgent.mockReturnValue(never.promise);

    ctrl.startRootRun(makeRunRequest('First run.'));
    ctrl.startRootRun(makeRunRequest('Second run.'));

    expect(() => disposables.dispose()).toThrow(firstFailure);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it('keeps detached-child approvals answerable after the stopped root finalizes', async () => {
    const rootRun = 'root-stream' as RunId;
    const childRun = 'child-stream' as RunId;
    const { executions, interactions } = installOwnerSession();
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

    const rootRun = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
    mocks.executeAgent.mockImplementationOnce(
      async (
        _config: unknown,
        runId: RunId,
        options: ExecuteAgentMockOptions,
      ) => {
        const rootHandle = testRunHandle({
          runId,
          parentRunId: rootRun,
          agent: 'root',
        });
        const childHandle = testRunHandle({
          runId: 'child-exec',
          parentRunId: rootRun,
          childRunId: childRun,
          agent: 'child',
        });
        rootHandle.attachInterruptHandler({
          interrupt: () => {
            runs.untrack(rootHandle.runId);
            rootRun.resolve({
              category: 'toolUse',
              runId: rootHandle.runId as RunId,
              outcome: RUN_OUTCOME.CANCELLED,
              runId: rootRun,
            });
          },
        });
        runs.trackAgentRun(rootHandle, {
          status: RUN_PHASE.RUNNING,
        });
        runs.trackAgentRun(childHandle, {
          status: RUN_PHASE.RUNNING,
        });
        options.onStreamResolved?.(rootRun);
        return rootRun.promise;
      },
    );

    const session = makeSession();
    const disposables = new DisposableStore();
    const ctrl = createChatSessionController(
      makeInit({ session, disposables }),
    );
    ctrl.startRootRun(makeRunRequest('Delegate the calculation.'));
    await vi.waitFor(() => expect(session.runId).toBe(rootRun));

    ctrl.stopRun(rootRun);
    await session.runPromise;

    expect(session.runCompleted).toBe(true);
    expect(
      runs.getAgentHandleByStream(childRun)?.isChild,
    ).toBe(false);
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

    runs.untrack('child-exec');
    await vi.waitFor(() => {
      expect(disposeAdapter).toHaveBeenCalledOnce();
      expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
    });
    expect(detachResultToast).toHaveBeenCalledOnce();

    disposables.dispose();
    expect(disposeAdapter).toHaveBeenCalledOnce();
    runs.dispose();
  });

  it('releases a later root host while an earlier detached child remains active', async () => {
    const { executions } = installOwnerSession();
    const hostA = { emit: vi.fn(), close: vi.fn() };
    const hostB = { emit: vi.fn(), close: vi.fn() };
    const disposeAdapterA = vi.fn();
    const disposeAdapterB = vi.fn();
    const runA = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.COMPLETED>>();
    const runB = pDefer<ToolUseRunResult<typeof RUN_OUTCOME.COMPLETED>>();
    const rootARun = 'root-a' as RunId;
    const childARun = 'child-a' as RunId;
    const rootBRun = 'root-b' as RunId;
    let childARunId: RunId | undefined;
    let rootARunId: RunId | undefined;
    let rootBRunId: RunId | undefined;

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
          runId: RunId,
          options: ExecuteAgentMockOptions,
        ) => {
          rootARunId = runId;
          childARunId = 'child-a-exec' as RunId;
          trackLiveRun(
            executions,
            runId,
            rootARun,
            rootARun,
            'root-a',
          );
          trackLiveRun(
            executions,
            childARunId,
            rootARun,
            childARun,
            'child-a',
          );
          options.onStreamResolved?.(rootARun);
          return runA.promise;
        },
      )
      .mockImplementationOnce(
        async (
          _config: unknown,
          runId: RunId,
          options: ExecuteAgentMockOptions,
        ) => {
          rootBRunId = runId;
          trackLiveRun(
            executions,
            runId,
            rootBRun,
            rootBRun,
            'root-b',
          );
          options.onStreamResolved?.(rootBRun);
          return runB.promise;
        },
      );

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    const config = makeRunRequest('Check interaction ownership.');

    ctrl.startRootRun(config);
    await vi.waitFor(() => expect(rootARunId).toBeDefined());
    runs.untrack(rootARunId!);
    runA.resolve({
      category: 'toolUse',
      runId: rootARunId!,
      outcome: RUN_OUTCOME.COMPLETED,
      runId: rootARun,
    });
    await session.runPromise;
    expect(hostA.close).not.toHaveBeenCalled();

    ctrl.startRootRun(config);
    await vi.waitFor(() => expect(rootBRunId).toBeDefined());
    runs.untrack(rootBRunId!);
    runB.resolve({
      category: 'toolUse',
      runId: rootBRunId!,
      outcome: RUN_OUTCOME.COMPLETED,
      runId: rootBRun,
    });
    await session.runPromise;

    expect(hostB.close).toHaveBeenCalledOnce();
    expect(disposeAdapterB).toHaveBeenCalledOnce();
    expect(hostA.close).not.toHaveBeenCalled();
    expect(disposeAdapterA).not.toHaveBeenCalled();

    runs.untrack(childARunId!);
    await vi.waitFor(() => {
      expect(hostA.close).toHaveBeenCalledOnce();
      expect(disposeAdapterA).toHaveBeenCalledOnce();
    });
    runs.dispose();
  });

  it('retains a root host while a child is activating', async () => {
    const { executions } = installOwnerSession();
    const presentationHost = { emit: vi.fn(), close: vi.fn() };
    const disposeAdapter = vi.fn();
    const rootRun = 'activation-root' as RunId;
    const childRun = 'activation-child' as RunId;
    const childRunId = 'activation-child-exec' as RunId;
    let releaseChildActivation = (): void => undefined;

    mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
    mocks.createTuiHostInteractions.mockReturnValue({
      cancel: vi.fn(),
      dispose: disposeAdapter,
    });
    mocks.executeAgent.mockImplementationOnce(
      async (
        _config: unknown,
        runId: RunId,
        options: ExecuteAgentMockOptions,
      ) => {
        trackLiveRun(
          executions,
          runId,
          rootRun,
          rootRun,
          'root',
        );
        options.onStreamResolved?.(rootRun);
        releaseChildActivation = runs.reserveChildActivation({
          runId: childRunId,
          parentRunId: rootRun,
          childRunId: childRun,
          interrupt: vi.fn(),
          detach: vi.fn(),
          isDetached: () => false,
        });
        runs.untrack(runId);
        return {
          category: 'toolUse',
          runId,
          outcome: RUN_OUTCOME.COMPLETED,
          runId: rootRun,
        };
      },
    );

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    ctrl.startRootRun(makeRunRequest('Start a child and finish immediately.'));
    await session.runPromise;

    expect(presentationHost.close).not.toHaveBeenCalled();
    expect(disposeAdapter).not.toHaveBeenCalled();

    trackLiveRun(
      executions,
      childRunId,
      rootRun,
      childRun,
      'child',
    );
    expect(presentationHost.close).not.toHaveBeenCalled();

    // The activation outlives the child's turn handles; the host is held
    // until the loop's own disposer runs.
    runs.untrack(childRunId);
    expect(presentationHost.close).not.toHaveBeenCalled();
    releaseChildActivation();
    await vi.waitFor(() => {
      expect(presentationHost.close).toHaveBeenCalledOnce();
      expect(disposeAdapter).toHaveBeenCalledOnce();
    });
    runs.dispose();
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
    session.runId = 'root-a' as RunId;
    ctrl.stopRun('root-a' as RunId);
    for (const present of resultPresenters) present('Failure A');
    runA.resolve({
      category: 'toolUse',
      runId: 'exec-a' as RunId,
      outcome: RUN_OUTCOME.CANCELLED,
      runId: 'root-a' as RunId,
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
      runId: 'exec-b' as RunId,
      outcome: RUN_OUTCOME.FAILED,
      runId: 'root-b' as RunId,
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
    expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
  });

  it('cannot miss the final survivor untracking at host-listener registration', async () => {
    const presentationHost = {
      emit: vi.fn(),
      close: mocks.presentationHostClose,
    } as unknown as CliRuntimeHost;
    const detachRegistrationListener = vi.fn();
    let childActive = true;
    mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
    mocks.getActiveRunIds.mockImplementation(() =>
      childActive ? ['child-exec'] : [],
    );
    mocks.getRunHandle.mockImplementation(() =>
      childActive ? { presentationHost } : undefined,
    );
    mocks.addRunRegistrationListener.mockImplementation(
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
    expect(mocks.addRunRegistrationListener).toHaveBeenCalledOnce();
    expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
    expect(mocks.detachHostInteractions).toHaveBeenCalledOnce();
    expect(detachRegistrationListener).toHaveBeenCalledOnce();
  });

  it('reserves the root-run slot before tryResumeRun awaits persisted state', async () => {
    const preload = pDefer<void>();
    const session = makeSession({ runCompleted: true });
    const snapshotStore = makeResumeSnapshotStore({
      preload: () => preload.promise,
      runId: undefined,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resumed = ctrl.tryResumeRun('stream-1');

    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);

    preload.resolve(undefined);
    await expect(resumed).resolves.toBe(false);
    expect(session.runCompleted).toBe(true);
  });

  it('reserves the root-run slot before resume() awaits the resolution', async () => {
    const configRead = pDefer<null>();
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      readMeta: async () => null,
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
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: makeResumeSnapshotStore({ config }) }),
    );

    await ctrl.resume('exec-resume' as RunId);
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

      await ctrl.resume('exec-resume' as RunId);
      await session.runPromise;

      expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
        describeFollowUpFailure(failure),
      );
      expect(sessionMeta.get()).toEqual(previousMetadata);
      expect(mocks.setCliHelperModel).not.toHaveBeenCalled();
      expect(mocks.clearLocalTranscript).not.toHaveBeenCalled();
      expect(session.runId).toBeUndefined();
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
    const init = makeInit({
      session,
      snapshotStore: makeResumeSnapshotStore({}),
    });
    const ctrl = createChatSessionController(init);

    await ctrl.resume('exec-resume' as RunId);
    await session.runPromise;

    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
  });

  it('manual resume supersedes stale interrupted recovery state', async () => {
    const session = makeSession({
      interruptedRunId: 'stream-interrupted' as RunId,
      runCompleted: true,
      stopRequested: true,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: makeResumeSnapshotStore({}) }),
    );

    await ctrl.resume('aaaaaa' as RunId);
    await session.runPromise;

    expect(session.runId).toBe('stream-resume');
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
    // different stream) fires while A is still suspended. Exactly one caller
    // (A) holds the slot end to end, so B must bail out rather than claim it
    // and start work that A would clobber on waking.
    const configRead = pDefer<null>();
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      readMeta: async () => null,
    });
    const session = makeSession({ runCompleted: true });
    const snapshotStoreForB = makeResumeSnapshotStore({
      runId: undefined,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: snapshotStoreForB }),
    );

    const resumeA = ctrl.resume('aaaaaa' as RunId);
    // A is now suspended inside the config read; the slot is
    // already claimed.
    expect(session.runPromise).toBeDefined();
    expect(session.runCompleted).toBe(false);

    // The follow-up wake for a different stream fires while A is still
    // suspended. It must bail out synchronously, before touching the
    // snapshot store, because the slot is already held.
    const resumedB = ctrl.tryResumeRun('stream-b');
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
    // out instead of silently starting the resumed run once the
    // awaits finish.
    const ensureLoaded = pDefer<void>();
    installSession({
      transcripts: {
        ensureLoaded: () => Effect.promise(() => ensureLoaded.promise),
      },
    });

    const session = makeSession({
      interruptedRunId: 'stream-interrupted' as RunId,
      runCompleted: true,
    });
    const snapshotStore = makeResumeSnapshotStore({});
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
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resumed = ctrl.resume('aaaaaa' as RunId);
    // resume() has claimed the slot synchronously; once the durable record
    // resolves it suspends inside defaultSession().transcripts.ensureLoaded()
    // with session.runId already set to the resumed stream.
    expect(session.runPromise).toBeDefined();
    await vi.waitFor(() => expect(session.runId).toBe('stream-resume'));
    // #8273 regression: the controller must publish the run facts so status
    // rendering can derive the Ctrl-C hint from signals instead of calling
    // impure session closures that memoized renders cache stale.
    expect(rootRunPending.get()).toBe(true);
    expect(rootRunId.get()).toBe('stream-resume');

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
    expect(session.interruptedRunId).toBe('stream-resume');
  });

  it('marks the resumed stream, not the previous one, for a Ctrl-C issued before adoption', async () => {
    // The synchronous slot claim drops the pre-resume stream, so a stop in the
    // window before `onResumeResolved` has no stream to mark: without the
    // re-read at adoption the user's Ctrl-C would leave no recoverable
    // conversation, and any stale stream it did find would be the wrong one.
    const resumeReached = pDefer<void>();
    const session = makeSession({
      runId: 'stream-previous' as RunId,
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
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore: makeResumeSnapshotStore({}) }),
    );

    const resumed = ctrl.resume('aaaaaa' as RunId);
    await vi.waitFor(() => expect(mocks.resumeRun).toHaveBeenCalledOnce());
    ctrl.stop();
    expect(session.interruptedRunId).toBeUndefined();

    resumeReached.resolve();
    await resumed;
    await session.runPromise;

    expect(session.interruptedRunId).toBe('stream-resume');
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stream.stop',
        runId: 'stream-previous',
      }),
    );
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
  });

  it('reports resume rehydration failures without rejecting the TUI submit path', async () => {
    const session = makeSession({
      interruptedRunId: 'stream-interrupted' as RunId,
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

    await expect(ctrl.resume('aaaaaa' as RunId)).resolves.toBeUndefined();
    await session.runPromise;

    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'snapshot load failed',
    );
    expect(session.runExitCode).toBe(CliExitCode.AgentError);
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedRunId).toBe('stream-interrupted');
    expect(chatTuiCanStartRootRun(session)).toBe(true);
  });

  it('forwards a stop issued during manual resume helper-model setup', async () => {
    const helperModel = pDefer<void>();
    mocks.setCliHelperModel.mockReturnValueOnce(helperModel.promise);

    const session = makeSession({ runCompleted: true });
    const snapshotStore = {
      load: vi.fn(() => Effect.void),
      read: vi.fn(() =>
        Effect.succeed({
          runUsage: {},
          todos: [],
          plan: undefined,
        }),
      ),
      getRunMetadata: vi.fn(() => ({})),
    } as unknown as RunSnapshotStore;
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );
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
    const snapshotStore = makeResumeSnapshotStore({});
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    await expect(ctrl.tryResumeRun('child-stream')).resolves.toBe(false);

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
      runId: 'exec-1',
      config,
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
    const init = makeInit({ session, snapshotStore });
    const ctrl = createChatSessionController(init);

    await expect(ctrl.tryResumeRun('stream-1')).resolves.toBe(true);

    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
    const resumeOptions = mocks.resumeRun.mock.calls[0]?.[1] as
      ResumeRunOptions | undefined;
    expect(resumeOptions?.isCancellationRequested?.()).toBe(false);
    session.stopRequested = true;
    expect(resumeOptions?.isCancellationRequested?.()).toBe(true);
    expect(rootRunId.get()).toBe('stream-1');
    expect(mocks.notify).not.toHaveBeenCalledWith('agentFinished');
    expect(sessionMeta.get().cliMultiAgentPresetId).toBeUndefined();
    expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
  });

  it('keeps an automatic resume cancelled after clear resets session state', async () => {
    const leaseCheckStarted = pDefer<void>();
    const releaseLeaseCheck = pDefer<void>();
    const snapshotStore = makeResumeSnapshotStore({
      runId: 'exec-1',
      config: makeResumeConfig(),
    });
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
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resume = ctrl.tryResumeRun('stream-1', {
      runId: 'stream-1' as RunId,
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

    await expect(ctrl.tryResumeRun('stream-1')).resolves.toBe(true);

    expect(session.interruptedRunId).toBeUndefined();
    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('rejects recovery only until the interrupted run promise settles', async () => {
    const teardown = pDefer<void>();
    const snapshotStore = makeResumeSnapshotStore({
      runId: 'exec-1',
      config: makeResumeConfig(),
    });
    const session = makeSession({
      runId: 'stream-1',
      runPromise: teardown.promise,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    ctrl.stop();
    // Root finalization publishes slot availability before its promise has
    // completely settled.
    session.markRunCompleted();
    // `/clear` may reset the mutable session state while the interrupted
    // promise is still settling. The captured promise must remain the guard.
    session.clearRunState();

    await expect(
      ctrl.tryResumeRun('stream-1', {
        runId: 'stream-1' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(false);

    expect(snapshotStore.preload).not.toHaveBeenCalled();
    expect(session.stopRequested).toBe(false);
    expect(mocks.resumeRun).not.toHaveBeenCalled();

    teardown.resolve();
    await teardown.promise;
    resumeWithAutoResumeData();

    await expect(
      ctrl.tryResumeRun('stream-1', {
        runId: 'stream-1' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(true);

    expect(snapshotStore.preload).toHaveBeenCalledWith(['stream-1']);
    expect(mocks.resumeRun).toHaveBeenCalledOnce();
  });

  it('retains every unsettled interrupted-run recovery blocker', async () => {
    const firstTeardown = pDefer<void>();
    const secondTeardown = pDefer<void>();
    const snapshotStore = makeResumeSnapshotStore({
      runId: 'exec-1',
      config: makeResumeConfig(),
    });
    const session = makeSession({
      runId: 'stream-1',
      runPromise: firstTeardown.promise,
    });
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    ctrl.stop();
    session.markRunCompleted();
    session.clearRunState();

    session.markRunPending(secondTeardown.promise);
    session.runId = 'stream-2' as RunId;
    ctrl.stop();
    session.markRunCompleted();
    session.clearRunState();

    secondTeardown.resolve();
    await secondTeardown.promise;
    await expect(
      ctrl.tryResumeRun('stream-1', {
        runId: 'stream-1' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(false);

    firstTeardown.resolve();
    await firstTeardown.promise;
    resumeWithAutoResumeData();
    await expect(
      ctrl.tryResumeRun('stream-1', {
        runId: 'stream-1' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(true);

    expect(snapshotStore.preload).toHaveBeenCalledOnce();
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

    const launcherResume = ctrl.tryResumeRun('stream-1');
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
      'exec-1',
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
      'exec-1',
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
              runId: 'stream:test' as RunId,
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
    expect(session.interruptedRunId).toBe('stream-1');
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
    const snapshotStore = makeResumeSnapshotStore({
      runId: 'exec-1',
      config: makeResumeConfig(),
      load: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('load failed')),
    });
    const { ctrl, session } = makeInterruptedController(
      Promise.resolve(),
      true,
      snapshotStore,
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
    // interrupted stream back or the input typed during the interruption is
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
    await vi.waitFor(() =>
      expect(session.interruptedRunId).toBe('stream-1'),
    );
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
  });

  it('preserves root ownership when auto-resuming a child stream', async () => {
    const root = 'root-stream' as RunId;
    const child = 'child-stream' as RunId;
    rootRunId.set(root);
    const snapshotStore = makeResumeSnapshotStore({
      runId: 'exec-1',
      config: makeResumeConfig(),
      parentRunId: root,
    });
    const ctrl = createChatSessionController(makeInit({ snapshotStore }));

    await expect(ctrl.tryResumeRun(child)).resolves.toBe(true);

    expect(rootRunId.get()).toBe(root);
    expect(mocks.notify).toHaveBeenCalledWith('agentFinished');
  });

  it('does not auto-resume after stop during helper-model setup', async () => {
    const helperModel = pDefer<void>();
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    const snapshotStore = makeResumeSnapshotStore({
      runId: 'exec-1',
      config,
    });
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
    const ctrl = createChatSessionController(
      makeInit({ session, snapshotStore }),
    );

    const resumed = ctrl.tryResumeRun('stream-1');
    await vi.waitFor(() =>
      expect(mocks.setCliHelperModel).toHaveBeenCalledWith(config.model),
    );
    ctrl.stop();
    helperModel.resolve(undefined);

    await expect(resumed).resolves.toBe(false);
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
  });
});
