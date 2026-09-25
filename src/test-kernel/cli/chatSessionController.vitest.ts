// Unit tests for the chat-session controller's run-slot ownership, stop and
// resume paths, and presentation-host lifecycle. The agent run boundary
// (launch, resume, result toast, record reads) is injected through the
// controller's own `agentRuns` init seam; the session surfaces the controller
// reasons about (run registry, event hub, run status, host interactions) are
// the real runtime objects wherever a test asserts through them.

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Scope,
  SubscriptionRef,
} from 'effect';
import { it } from '@effect/vitest';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  runAgent: vi.fn(),
  request: vi.fn(),
  notifyFollowUpSent: vi.fn(),
  workspaceGet: vi.fn(),
  globalGet: vi.fn(),
  getRunRecords: vi.fn(),
  setCliHelperModel: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  presentationHostClose: vi.fn(),
  sessionStub: vi.fn(),
  getActiveRunIds: vi.fn(),
  getRunHandle: vi.fn(),
  detachHostInteractions: vi.fn(),
  attachTerminalResultToast: vi.fn(),
  createTuiHostInteractions: vi.fn(),
  resumeRun: vi.fn(),
  appendLocalAssistantTranscript: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
  clearLocalTranscript: vi.fn(),
  moveLocalTranscriptToRun: vi.fn(),
  reportRequestDefect: vi.fn(),
  followUpSubmit: vi.fn(),
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
  reportRequestDefect: mocks.reportRequestDefect,
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
import type { SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import { makeFollowUpDeliveryQueue } from '@cli/chat/followUpDeliveryQueue';
import {
  patchSessionMeta,
  draftRestoreRequest,
  rootRunId,
  sessionMeta,
  transientNotice,
} from '@cli/chat/tui/state/cliState';
import { currentView } from '@cli/chat/tui/state/sessionView';
import {
  chatTuiCanStartRootRun,
  runStopFacts,
  TuiSession,
  type RootRunSettled,
} from '@cli/chat/tui/state/sessionRunState';
import { DisposableStore } from '@platform/disposable';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  aggregateId,
  AgentCategory,
  emptyRunEndOutput,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import { TEXRA_APPROVAL_POLICY_DEFAULT } from '@shared/approvalPolicy';
import { DatabaseReadFailed } from '@shared/session/database';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import {
  admitInterruptibleRun,
  testRunHandle,
} from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import { ensureError } from '@utils/errors/errorMessage';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

// The state stores the controller's setting reads land on, as ports of the
// installed fake host rather than a module mock of `platform()`: the setting
// reads (the multi-agent preset name) take the session's own roots, which this
// file's stub takes from the installed host, and the kernel's setup file
// installs a host before this file's mocks are registered.
setupPlatform(
  {},
  {
    globalState: { get: mocks.globalGet, update: () => Effect.void },
    workspaceState: { get: mocks.workspaceGet, update: () => Effect.void },
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
  readonly runSettled?: RootRunSettled;
  readonly runCompleted?: boolean;
  readonly stopRequested?: boolean;
}

function makeSession(overrides: SessionFixture = {}): TuiSession {
  const session = new TuiSession(() => undefined);
  if (overrides.runSettled) session.markRunPending(overrides.runSettled);
  if (overrides.runCompleted) session.markRunCompleted();
  if (overrides.runId) session.runId = overrides.runId;
  session.interruptedRunId = overrides.interruptedRunId;
  session.stopRequested = overrides.stopRequested ?? false;
  return session;
}

/** The controller's resume port, run the way the platform port runs it. */
function runTryResume(
  ctrl: ReturnType<typeof createChatSessionController>,
  runId: RunId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  return testRuntime().runPromise(ctrl.tryResumeRun(runId, recovery));
}

/** The controller's resume command, run the way the Ink handler runs it. */
function runResume(
  ctrl: ReturnType<typeof createChatSessionController>,
  runId: RunId,
): Promise<void> {
  return testRuntime().runPromise(ctrl.resume(runId));
}

/** The composer's submit path, run the way the composer runs it. */
function runSubmit(
  ctrl: ReturnType<typeof createChatSessionController>,
  line: string,
): Promise<void> {
  return testRuntime().runPromise(ctrl.submit(line));
}

/** An admitted interruption's settlement, as the composer awaits it. */
function awaitAdmission<E>(
  completion: Deferred.Deferred<boolean, E>,
): Promise<boolean> {
  return testRuntime().runPromise(Deferred.await(completion));
}

/** The claimed root run's settlement, run the way the exit drain runs it. */
function awaitRunSettled(session: TuiSession): Promise<void> {
  return testRuntime().runPromise(session.runSettled ?? Effect.void);
}

/** A root-run claim the test settles by hand, as a run chain settles it. */
function pendingRunClaim(): {
  readonly settled: RootRunSettled;
  /** Settle the claim, then let the fibers parked on it run their
   *  continuations before the next assertion reads what they wrote. */
  readonly settle: () => Promise<void>;
} {
  const claim = Deferred.makeUnsafe<void, Error>();
  return {
    settled: Deferred.await(claim),
    settle: async (): Promise<void> => {
      Deferred.doneUnsafe(claim, Effect.void);
      await testRuntime().runPromise(
        Effect.andThen(Deferred.await(claim), Effect.yieldNow),
      );
    },
  };
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
  const scope = Scope.makeUnsafe();
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return {
    // Only when the test brings none: a new session resets the one claim.
    session: overrides.session ?? makeSession(),
    runtimeSession: mocks.sessionStub(),
    getSessionContext: () => makeSessionContext(),
    disposables: new DisposableStore(),
    followUpQueue: Effect.runSync(makeFollowUpDeliveryQueue(scope)),
    initialAgent: 'demo-agent',
    initialModel: 'demo-model',
    initialModelSource: 'builtin-default',
    cwd: '/tmp/workspace',
    getSlashCommandContext: () => {
      throw new Error('slash commands are not exercised here');
    },
    secrets: new FakeSecrets(),
    stores: makeFakeSettingsStores().stores,
    runtime: testRuntime(),
    // The agent boundary, injected the way the init seam intends: the bag is
    // the suite's own, so assertions read the same `mocks` entries the old
    // module mocks fed.
    agentRuns: {
      launch: (...args: unknown[]) => mocks.runAgent(...args),
      resume: (...args: unknown[]) => mocks.resumeRun(...args),
      attachResultToast: (...args: unknown[]) =>
        mocks.attachTerminalResultToast(...args),
      records: (...args: unknown[]) => {
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
    } as ChatSessionControllerInit['agentRuns'],
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
 * Installs the session stub the controller surfaces receive. Every surface is
 * a stub the controller can call; a test that asserts through a real runtime
 * object swaps just that surface in. `sessionStub` is a bare mock, so the
 * override map is untyped here exactly as the returned session is.
 */
/** The session's view ref, as a value the harness can install. The run lives
 *  in this helper; a test body composes with `yield*` instead. */
const installableViewRef = () =>
  Effect.runSync(SubscriptionRef.make(currentView()));

function installSession(overrides: Record<string, unknown> = {}): void {
  const runs = {
    getActiveIds: mocks.getActiveRunIds,
    getHandle: mocks.getRunHandle,
  };
  mocks.sessionStub.mockReturnValue({
    roots: testWorkspaceRoots(),
    approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
    interactions: {
      use: vi.fn(() => Effect.succeed(mocks.detachHostInteractions)),
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
      submitBatch: mocks.followUpSubmit.mockReturnValue(
        Effect.succeed({ kind: 'queued' }),
      ),
    },
    approvals: { registerRunParent: vi.fn() },
    runs,
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
            yield* session.runs
              .stopAgentRun(req.runId, {
                detachActiveChildren: req.detachActiveChildren ?? undefined,
              })
              // The handler words a refused stop as a request error; this
              // stub has no such vocabulary, so a refusal is a defect here.
              .pipe(Effect.orDie);
          }
          return { kind: 'done' };
        }),
    },
  });
  mocks.sessionStub.mockReturnValue(owner);
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
  Effect.gen(function* () {
    // The real `resumeRun` rearranges the host onto the resumed run only
    // after its own retrieval succeeded, so every stand-in that reaches a launch
    // must run the hook or the caller never adopts the run.
    if (options.onResumeResolved) yield* options.onResumeResolved();
    options.onFollowUpQueueReady?.({
      runId: '7e5701' as RunId,
      kind: 'recovery',
    });
    return STARTED;
  });

function resumeWithAutoResumeData(): void {
  mocks.resumeRun.mockImplementation(defaultResumeRun);
}

function makeInterruptedController(
  runSettled: RootRunSettled,
  runCompleted: boolean,
) {
  const session = makeSession({
    runId: 'a11111' as RunId,
    interruptedRunId: 'a11111' as RunId,
    runSettled,
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
  await expect(awaitAdmission(admission.completion)).resolves.toBe(false);
}

async function expectInterruptedRetry(
  ctrl: ReturnType<typeof createChatSessionController>,
  expectedTexts: readonly string[],
): Promise<void> {
  resumeWithAutoResumeData();
  const retry = ctrl.admitInterruptedFollowUp({ text: 'Retry.' });
  expect(retry.kind).toBe('accepted');
  if (retry.kind !== 'accepted') return;
  await expect(awaitAdmission(retry.completion)).resolves.toBe(true);
  expect(mocks.resumeRun).toHaveBeenCalledWith(
    'a11111',
    expect.objectContaining({
      extraFollowUps: expectedTexts.map((text) => ({ text })),
    }),
  );
}

describe('CLI terminal outcome resolution', () => {
  // The persisted outcome is a committed `run.end` row on a real session over
  // the fake platform's storage; the read path under test folds it, so no
  // record store is stubbed.
  it.effect('prefers the persisted post-shutdown outcome', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      const runId = '5d0001' as RunId;
      publishTestRunStart(session, runId);
      session.publish([
        {
          type: 'run.end',
          aggregateId: aggregateId('run', runId),
          outcome: RUN_OUTCOME.CANCELLED,
          output: emptyRunEndOutput(AgentCategory.ToolUse),
        },
      ]);
      yield* session.settlePublications();

      expect(
        yield* readCliRunOutcomeState(session, {
          outcome: RUN_OUTCOME.COMPLETED,
          output: { category: 'toolUse', response: '', files: [] },
          runId,
        }),
      ).toEqual({
        outcome: RUN_OUTCOME.CANCELLED,
        outcomePersisted: true,
      });
    }),
  );

  it.effect(
    'reports an outcome read failure and retains the completed run',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        const runId = 'b0f001' as RunId;
        publishTestRunStart(session, runId);
        yield* session.settlePublications();
        const reportReadFailure = vi.fn();
        // The read fails the way a corrupt store fails it: through the
        // session's own records port, typed.
        vi.spyOn(session, 'readRunRecords').mockReturnValue(
          Effect.fail(
            new DatabaseReadFailed({
              path: 'run-records',
              cause: new Error('metadata read failed'),
            }),
          ),
        );

        expect(
          yield* readCliRunOutcomeState(
            session,
            {
              outcome: RUN_OUTCOME.COMPLETED,
              output: { category: 'toolUse', response: '', files: [] },
              runId,
            },
            reportReadFailure,
          ),
        ).toEqual({
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
      }),
  );
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
      (_key: unknown, defaultValue?: unknown) => Effect.succeed(defaultValue),
    );
    mocks.globalGet.mockImplementation(
      (_key: unknown, defaultValue?: unknown) => Effect.succeed(defaultValue),
    );
    // The helper-model write is an Effect now, so the stubs are too.
    mocks.setCliHelperModel.mockReturnValue(Effect.void);
    mocks.presentationHostClose.mockReturnValue(Effect.void);
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
    mocks.reportRequestDefect.mockReturnValue(
      Effect.succeed('The request failed inside TeXRA; see the log.'),
    );
    installSession();
    mocks.resumeRun.mockImplementation(defaultResumeRun);
    installResumeRunStore();
    seedView(viewWith([]));
    rootRunId.set(undefined);
  });

  it('does not surface an intentional stop as an error', async () => {
    const run = createDeferred<never>();
    const executed = createDeferred();
    const session = makeSession();
    mocks.executeAgent.mockImplementationOnce(() => {
      executed.resolve();
      return run.promise;
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.startRootRun(makeRunRequest('Check the draft.'));
    await executed.promise;
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    ctrl.stop();
    run.reject(new Error('run stopped'));
    await awaitRunSettled(session);

    expect(mocks.appendLocalErrorTranscript).not.toHaveBeenCalled();
    expect(session.runExitCode).toBe(CliExitCode.Success);
  });

  it.live(
    'keeps detached-child approvals answerable after the stopped root finalizes',
    () =>
      Effect.gen(function* () {
        const childRun = 'c00001' as RunId;
        const { session: runtimeSession, runs } = installOwnerSession();
        const disposeAdapter = vi.fn();
        const detachResultToast = vi.fn();
        const presentationHost = {
          emit: vi.fn(),
          close: mocks.presentationHostClose,
          attachRunProgressRenderer: vi.fn(() => vi.fn()),
        } as unknown as CliRuntimeHost;
        mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
        mocks.createTuiHostInteractions.mockReturnValue({
          dispose: disposeAdapter,
        });
        mocks.attachTerminalResultToast.mockReturnValue(detachResultToast);

        const rootRunResult =
          createDeferred<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
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
            // A launch states both runs in the plane before it tracks them: the
            // stop publishes `run.detach` on the child's own aggregate, and a run
            // aggregate opens with its `run.start` and nothing else.
            publishTestRunStart(runtimeSession, runId);
            publishTestRunStart(runtimeSession, childRun, { parent: runId });
            runs.track(rootHandle);
            runs.track(childHandle);
            // The root run's stop is its roster fiber's interruption: the
            // stop lands there, untracks the root, and the run resolves
            // cancelled through its own result.
            admitInterruptibleRun(runs, runId, () => {
              runs.untrack(runId);
              rootRunResult.resolve({
                category: 'toolUse',
                runId,
                outcome: RUN_OUTCOME.CANCELLED,
              });
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
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(runs.getHandle(childRun)).toBeDefined()),
        );

        // The stop Ctrl-C sends under "Keep subagents running": the root
        // stops and its live children detach.
        const owner = mocks.sessionStub() as SessionHandle;
        yield* owner.requests.request({
          kind: 'run.stop',
          runId: rootRun,
          detachActiveChildren: true,
        });
        yield* Effect.promise(() => awaitRunSettled(session));

        expect(session.runCompleted).toBe(true);
        // The local sever follows the committed `run.detach` now, so the
        // promotion lands with that batch rather than with the stop's admission.
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(runs.getHandle(childRun)?.isChild).toBe(false),
          ),
        );
        expect(disposeAdapter).not.toHaveBeenCalled();
        expect(detachResultToast).toHaveBeenCalledOnce();
        expect(mocks.presentationHostClose).not.toHaveBeenCalled();

        // The request opens on the child's own aggregate, which the launch
        // already stated in the plane.
        const requestId = 'bash-detached-child';
        const approval = yield* Effect.forkScoped(
          runtimeSession.openRequest(childRun, {
            kind: 'bash',
            data: {
              requestId,
              command: 'printf child',
              allowBypass: true,
              runId: childRun,
            },
          }),
        );
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(
              SubscriptionRef.getUnsafe(runtimeSession.view).requests.map(
                (request) => request.requestId,
              ),
            ).toEqual([requestId]),
          ),
        );
        runtimeSession.publish([
          {
            type: 'request.decided',
            aggregateId: aggregateId('run', childRun),
            requestId,
            decision: { action: 'approve' },
          },
        ]);
        expect(yield* Fiber.join(approval)).toEqual({ action: 'approve' });

        // The host lives for the chat session, not for the runs it served.
        runs.untrack(childRun);
        expect(disposeAdapter).not.toHaveBeenCalled();

        disposables.dispose();
        expect(disposeAdapter).toHaveBeenCalledOnce();
        expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
        runs.dispose();
      }),
  );

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
    const runA =
      createDeferred<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
    const runB = createDeferred<ToolUseRunResult<typeof RUN_OUTCOME.FAILED>>();
    const runAgentCalledTwice = createDeferred();
    mocks.runAgent
      .mockReturnValueOnce(
        Effect.tryPromise({ try: () => runA.promise, catch: ensureError }),
      )
      .mockImplementationOnce(() => {
        runAgentCalledTwice.resolve();
        return Effect.tryPromise({
          try: () => runB.promise,
          catch: ensureError,
        });
      });

    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    const config = makeRunRequest('Check presenter ownership.');
    ctrl.startRootRun(config);
    session.runId = 'a0000a' as RunId;
    ctrl.stop();
    for (const present of resultPresenters) present('Failure A');
    runA.resolve({
      category: 'toolUse',
      outcome: RUN_OUTCOME.CANCELLED,
      runId: 'a0000a' as RunId,
    });
    await awaitRunSettled(session);

    expect(resultPresenters).toHaveLength(0);

    const presenterAdded = createDeferred();
    mocks.attachTerminalResultToast.mockImplementationOnce(() => {
      const host =
        mocks.attachTerminalResultToast.mock.calls.length === 1 ? hostA : hostB;
      const present = (message: string) =>
        host.emit('requestShowError', { message });
      resultPresenters.add(present);
      presenterAdded.resolve();
      return () => resultPresenters.delete(present);
    });

    ctrl.startRootRun(config);
    await runAgentCalledTwice.promise;
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(mocks.attachTerminalResultToast).toHaveBeenCalledTimes(2);
    expect(session.runCompleted).toBe(false);
    await presenterAdded.promise;
    expect(resultPresenters).toHaveLength(1);
    for (const present of resultPresenters) present('Failure B');
    runB.resolve({
      category: 'toolUse',
      outcome: RUN_OUTCOME.FAILED,
      runId: 'b0000b' as RunId,
    });
    await awaitRunSettled(session);

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

    await expect(awaitRunSettled(session)).resolves.toBeUndefined();
    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'launch defect',
    );
    expect(session.runCompleted).toBe(true);
  });

  it('reports a run failure whose cause also carries an interrupt', async () => {
    // Fail-fast concurrency and interrupted teardown both fold an Interrupt
    // into a genuine failure's Cause; recovery must still see the failure.
    mocks.runAgent.mockReturnValueOnce(
      Effect.failCause(
        Cause.fromReasons([
          Cause.makeFailReason(new Error('run failed mid-teardown')),
          Cause.makeInterruptReason(),
        ]),
      ),
    );
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.startRootRun(makeRunRequest('Check racing failure.'));

    await expect(awaitRunSettled(session)).resolves.toBeUndefined();
    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'run failed mid-teardown',
    );
    expect(session.runExitCode).toBe(CliExitCode.AgentError);
    expect(session.runCompleted).toBe(true);
  });

  it('reserves the root-run slot before tryResumeRun awaits persisted state', async () => {
    const configRead = createDeferred<null>();
    const session = makeSession({ runCompleted: true });
    // Nothing persisted for the run: the resume gives the slot back once the
    // durable read it waited on resolves.
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      exists: async () => false,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = runTryResume(ctrl, 'a11111' as RunId);

    expect(session.runSettled).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);

    configRead.resolve(null);
    await expect(resumed).resolves.toBe(false);
    expect(session.runCompleted).toBe(true);
  });

  it('reserves the root-run slot before resume() awaits the resolution', async () => {
    const configRead = createDeferred<null>();
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      exists: async () => false,
    });
    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumed = runResume(ctrl, 'aaaaaa' as RunId);

    // The claim (tryClaimRootRunSlot) must land synchronously, before
    // resume() ever reaches its first await — same contract as
    // tryResumeRun above.
    expect(session.runSettled).toBeDefined();
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

    await runResume(ctrl, 'ec0001' as RunId);
    await awaitRunSettled(session);

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

      await runResume(ctrl, 'ec0001' as RunId);
      await awaitRunSettled(session);

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
        Effect.gen(function* () {
          if (options.onResumeResolved) yield* options.onResumeResolved();
          return { ...STARTED, outcome: RUN_PHASE.WAITING };
        }),
    );
    // A fake records reader, like every other resume test: the real
    // `getRunRecords` against this harness's storage-less platform fails
    // loudly, which resume() treats as a rehydration failure by contract.
    const init = makeInit({ session });
    const ctrl = createChatSessionController(init);

    await runResume(ctrl, 'ec0001' as RunId);
    await awaitRunSettled(session);

    expect(session.runExitCode).toBe(CliExitCode.Success);
  });

  it('manual resume supersedes stale interrupted recovery state', async () => {
    const session = makeSession({
      interruptedRunId: 'e11111' as RunId,
      runCompleted: true,
      stopRequested: true,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    await runResume(ctrl, 'aaaaaa' as RunId);
    await awaitRunSettled(session);

    expect(session.runId).toBe('aaaaaa');
    expect(session.interruptedRunId).toBeUndefined();
    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('transfers an admitted interruption batch to manual resume', async () => {
    const teardown = pendingRunClaim();
    const { ctrl } = makeInterruptedController(teardown.settled, true);
    const manualResumed = createDeferred();
    const baseResumeRun = mocks.resumeRun.getMockImplementation();
    mocks.resumeRun.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'aaaaaa') manualResumed.resolve();
      return baseResumeRun!(...args);
    });
    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Preserve this accepted message.',
    });
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') return;

    const manualResume = runResume(ctrl, 'aaaaaa' as RunId);
    await teardown.settle();

    await manualResume;
    await expect(awaitAdmission(admission.completion)).resolves.toBe(true);
    await manualResumed.promise;
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'aaaaaa',
      expect.objectContaining({
        extraFollowUps: [{ text: 'Preserve this accepted message.' }],
      }),
    );
  });

  it('resume() suspended on the resolution keeps a concurrent follow-up wake from also claiming the root-run slot', async () => {
    // resume(A) suspends on the config read (an await-suspension point)
    // with the slot already claimed; a follow-up wake (tryResumeRun for a
    // different run) fires while A is still suspended. Exactly one caller
    // (A) holds the slot end to end, so B must bail out rather than claim it
    // and start work that A would clobber on waking.
    const configRead = createDeferred<null>();
    mocks.getRunRecords.mockReturnValue({
      readConfig: () => configRead.promise,
      exists: async () => false,
    });
    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));

    const resumeA = runResume(ctrl, 'aaaaaa' as RunId);
    // A is now suspended inside the config read; the slot is
    // already claimed.
    expect(session.runSettled).toBeDefined();
    expect(session.runCompleted).toBe(false);

    // The follow-up wake for a different run fires while A is still
    // suspended. It must bail out synchronously, before reading anything,
    // because the slot is already held.
    const resumedB = runTryResume(ctrl, 'ab2222' as RunId);
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
    const rehydrated = createDeferred<void>();
    const session = makeSession({
      interruptedRunId: 'e11111' as RunId,
      runCompleted: true,
    });
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) =>
        Effect.gen(function* () {
          if (options.onResumeResolved) yield* options.onResumeResolved();
          yield* Effect.promise(() => rehydrated.promise);
          return options.isCancellationRequested?.()
            ? { failed: 'not_resumable' as const }
            : STARTED;
        }),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    holdRun('aaaaaa' as RunId);
    const resumed = runResume(ctrl, 'aaaaaa' as RunId);
    // resume() has claimed the slot synchronously; once the durable record
    // resolves it suspends inside the resume, after adoption, with
    // session.runId already set to the resumed run.
    expect(session.runSettled).toBeDefined();
    await vi.waitFor(() => expect(session.runId).toBe('aaaaaa'));
    // #8273 regression: the controller must publish the run facts so status
    // rendering can derive the Ctrl-C hint from signals instead of calling
    // impure session closures that memoized renders cache stale.
    expect(runStopFacts.get().runPending).toBe(true);
    expect(runStopFacts.get().runId).toBe('aaaaaa');

    // No live tool-use flow yet, so a Ctrl-C now is a clean exit, never a
    // resumable-idle one.
    expect(session.isResumableIdle()).toBe(false);

    // Ctrl-C fires while resume() is still rehydrating.
    ctrl.stop();
    expect(session.stopRequested).toBe(true);

    rehydrated.resolve();
    await resumed;
    await awaitRunSettled(session);

    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedRunId).toBe('aaaaaa');
  });

  it('marks the resumed run, not the previous one, for a Ctrl-C issued before adoption', async () => {
    // The synchronous slot claim drops the pre-resume run, so a stop in the
    // window before `onResumeResolved` has no run to mark: without the
    // re-read at adoption the user's Ctrl-C would leave no recoverable
    // conversation, and any stale run it did find would be the wrong one.
    const resumeReached = createDeferred<void>();
    const resumeStarted = createDeferred();
    const session = makeSession({
      runId: 'd00001' as RunId,
      runCompleted: true,
    });
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) => {
        resumeStarted.resolve();
        return Effect.gen(function* () {
          yield* Effect.promise(() => resumeReached.promise);
          if (options.onResumeResolved) yield* options.onResumeResolved();
          return options.isCancellationRequested?.()
            ? { failed: 'not_resumable' as const }
            : STARTED;
        });
      },
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    holdRun('aaaaaa' as RunId);
    const resumed = runResume(ctrl, 'aaaaaa' as RunId);
    await resumeStarted.promise;
    expect(mocks.resumeRun).toHaveBeenCalledOnce();
    ctrl.stop();
    expect(session.interruptedRunId).toBeUndefined();

    resumeReached.resolve();
    await resumed;
    await awaitRunSettled(session);

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
    mocks.setCliHelperModel.mockReturnValueOnce(
      Effect.fail(new Error('rehydration failed')),
    );
    const ctrl = createChatSessionController(makeInit({ session }));

    await expect(runResume(ctrl, 'aaaaaa' as RunId)).resolves.toBeUndefined();
    await awaitRunSettled(session);

    expect(mocks.appendLocalErrorTranscript).toHaveBeenCalledWith(
      'rehydration failed',
    );
    expect(session.runExitCode).toBe(CliExitCode.AgentError);
    expect(session.runCompleted).toBe(true);
    expect(session.interruptedRunId).toBe('e11111');
    expect(chatTuiCanStartRootRun(session)).toBe(true);
  });

  it.live(
    'surfaces a defected follow-up request instead of an unhandled rejection',
    () =>
      Effect.gen(function* () {
        // A collaborator rejecting inside `followUp.send` defects the request
        // Effect, which `Effect.match` does not recover: without the defect arm
        // the queued task rejects with no surfacing at all.
        holdRun('a11111' as RunId);
        installSession({
          view: yield* SubscriptionRef.make(currentView()),
        });
        mocks.request.mockReturnValueOnce(
          Effect.die(new Error('dispatch broke')),
        );
        const session = makeSession({
          runId: 'a11111' as RunId,
          runSettled: Effect.never,
        });
        const ctrl = createChatSessionController(
          makeInit({
            session,
            // A non-slash line never reads the context.
            getSlashCommandContext: () => ({}) as SlashCommandContext,
          }),
        );

        const defectReported = Deferred.makeUnsafe<void>();
        const baseReportDefect =
          mocks.reportRequestDefect.getMockImplementation();
        mocks.reportRequestDefect.mockImplementationOnce(
          (...args: unknown[]) => {
            Deferred.doneUnsafe(defectReported, Effect.void);
            return baseReportDefect!(...args);
          },
        );

        yield* ctrl.submit('Deliver this if you can.');

        yield* Deferred.await(defectReported);
        yield* Effect.yieldNow;
        expect(mocks.reportRequestDefect).toHaveBeenCalledOnce();
        expect(transientNotice.get()?.text).toContain(
          'The request failed inside TeXRA',
        );
        expect(
          draftRestoreRequest.get().map((request) => request.text),
        ).toContain('Deliver this if you can.');
        // A defect is no refusal: the run is not marked stopped.
        expect(session.stopRequested).toBe(false);
      }).pipe(Effect.provide(fakeProcessServices())),
  );

  it('restores the draft when the root run fails before the target folds', async () => {
    // The follow-up target never folds (no run in the view), so the race is
    // decided by the root run's settlement — and a failed settlement means
    // "the conversation ended", not a failure that escapes the delivery and
    // skips both restore branches.
    installSession({
      view: installableViewRef(),
    });
    const session = makeSession({
      runId: 'a11111' as RunId,
      runSettled: Effect.fail(new Error('model call failed')),
    });
    const ctrl = createChatSessionController(
      makeInit({
        session,
        getSlashCommandContext: () => ({}) as SlashCommandContext,
      }),
    );

    await runSubmit(ctrl, 'Keep this for me.');

    await vi.waitFor(() =>
      expect(
        draftRestoreRequest.get().map((request) => request.text),
      ).toContain('Keep this for me.'),
    );
  });

  it('forwards a stop issued during manual resume helper-model setup', async () => {
    const helperModel = createDeferred<void>();
    const helperModelStarted = createDeferred();
    mocks.setCliHelperModel.mockImplementationOnce(() => {
      helperModelStarted.resolve();
      return Effect.tryPromise(() => helperModel.promise);
    });

    const session = makeSession({ runCompleted: true });
    const ctrl = createChatSessionController(makeInit({ session }));
    const resumeCalled = createDeferred();
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) => {
        resumeCalled.resolve();
        return Effect.gen(function* () {
          if (options.onResumeResolved) yield* options.onResumeResolved();
          return {
            ...STARTED,
            outcome: options.isCancellationRequested?.()
              ? RUN_OUTCOME.CANCELLED
              : RUN_OUTCOME.COMPLETED,
          };
        });
      },
    );

    const resumeStarted = runResume(ctrl, 'aaaaaa' as RunId);
    await helperModelStarted.promise;
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith(
      expect.anything(),
      'demo-model',
    );

    ctrl.stop();
    helperModel.resolve(undefined);

    await resumeStarted;
    await resumeCalled.promise;
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'aaaaaa',
      expect.objectContaining({
        isCancellationRequested: expect.any(Function),
      }),
    );
    const resumeOptions = mocks.resumeRun.mock.calls[0]?.[1] as
      { readonly isCancellationRequested?: () => boolean } | undefined;
    expect(resumeOptions?.isCancellationRequested?.()).toBe(true);
    await awaitRunSettled(session);
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
  });

  it('reports a failed persisted-child wake while the CLI root slot is busy', async () => {
    const session = makeSession({
      runSettled: Effect.never,
      runCompleted: false,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    await expect(runTryResume(ctrl, 'c00001' as RunId)).resolves.toBe(false);

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

    await expect(runTryResume(ctrl, 'a11111' as RunId)).resolves.toBe(true);

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
    expect(sessionMeta.get().cliMultiAgentPresetId).toBeUndefined();
    expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
  });

  it('keeps an automatic resume cancelled after clear resets session state', async () => {
    const leaseCheckStarted = createDeferred<void>();
    const releaseLeaseCheck = createDeferred<void>();
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

    const resume = runTryResume(ctrl, 'a11111' as RunId, {
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
    const { ctrl, session } = makeInterruptedController(Effect.void, true);

    await expect(runTryResume(ctrl, 'a11111' as RunId)).resolves.toBe(true);

    expect(session.interruptedRunId).toBeUndefined();
    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('rejects recovery only until the interrupted run settles', async () => {
    const teardown = pendingRunClaim();
    const session = makeSession({
      runId: 'a11111' as RunId,
      runSettled: teardown.settled,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stop();
    // Root finalization publishes slot availability before its run has
    // completely settled.
    session.markRunCompleted();
    // `/clear` may reset the mutable session state while the interrupted run
    // is still settling. The captured settlement must remain the guard.
    session.clearRunState();

    await expect(
      runTryResume(ctrl, 'a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(false);

    expect(session.stopRequested).toBe(false);
    expect(mocks.resumeRun).not.toHaveBeenCalled();

    await teardown.settle();
    resumeWithAutoResumeData();

    await expect(
      runTryResume(ctrl, 'a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(true);

    expect(mocks.resumeRun).toHaveBeenCalledOnce();
  });

  it('retains every unsettled interrupted-run recovery blocker', async () => {
    const firstTeardown = pendingRunClaim();
    const secondTeardown = pendingRunClaim();
    const session = makeSession({
      runId: 'a11111' as RunId,
      runSettled: firstTeardown.settled,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.stop();
    session.markRunCompleted();
    session.clearRunState();

    session.markRunPending(secondTeardown.settled);
    session.runId = 'a22222' as RunId;
    ctrl.stop();
    session.markRunCompleted();
    session.clearRunState();

    await secondTeardown.settle();
    await expect(
      runTryResume(ctrl, 'a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(false);

    await firstTeardown.settle();
    resumeWithAutoResumeData();
    await expect(
      runTryResume(ctrl, 'a11111' as RunId, {
        runId: 'a11111' as RunId,
        kind: 'recovery',
      }),
    ).resolves.toBe(true);

    expect(mocks.resumeRun).toHaveBeenCalledOnce();
  });

  it('transfers an admitted interruption batch to launcher resume', async () => {
    const teardown = pendingRunClaim();
    const { ctrl } = makeInterruptedController(teardown.settled, true);
    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Transfer this accepted message.',
    });
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') return;

    const launcherResume = runTryResume(ctrl, 'a11111' as RunId);
    await teardown.settle();

    await expect(launcherResume).resolves.toBe(true);
    await expect(awaitAdmission(admission.completion)).resolves.toBe(true);
    expect(mocks.followUpSubmit).toHaveBeenCalledWith(
      'a11111',
      [{ text: 'Transfer this accepted message.' }],
      'live_owner',
    );
  });

  it('holds a message submitted while interruption teardown finishes', async () => {
    const teardown = pendingRunClaim();
    const { ctrl, session } = makeInterruptedController(
      teardown.settled,
      false,
    );

    const admission = ctrl.admitInterruptedFollowUp({
      text: 'Do not drop this message.',
    });
    expect(admission.kind).toBe('accepted');
    expect(mocks.resumeRun).not.toHaveBeenCalled();

    session.markRunCompleted();
    await teardown.settle();
    if (admission.kind !== 'accepted') return;
    await expect(awaitAdmission(admission.completion)).resolves.toBe(true);
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      'a11111',
      expect.objectContaining({
        extraFollowUps: [{ text: 'Do not drop this message.' }],
      }),
    );
    expect(session.stopRequested).toBe(false);
  });

  it('batches parallel messages into one interrupted resume', async () => {
    const teardown = pendingRunClaim();
    const { ctrl, session } = makeInterruptedController(
      teardown.settled,
      false,
    );

    const first = ctrl.admitInterruptedFollowUp({ text: 'First message.' });
    const second = ctrl.admitInterruptedFollowUp({ text: 'Second message.' });
    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('accepted');
    if (first.kind !== 'accepted' || second.kind !== 'accepted') return;
    expect(second.completion).toBe(first.completion);

    session.markRunCompleted();
    await teardown.settle();
    await expect(awaitAdmission(first.completion)).resolves.toBe(true);
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
    const resume = createDeferred<typeof STARTED>();
    const { ctrl } = makeInterruptedController(Effect.void, true);
    const resumeCalled = createDeferred();
    mocks.resumeRun.mockImplementationOnce(
      (_id: RunId, options: ResumeRunOptions) => {
        resumeCalled.resolve();
        return Effect.tryPromise({
          try: async () => {
            options.onFollowUpQueueReady?.({
              runId: '7e5701' as RunId,
              kind: 'recovery',
            });
            return resume.promise;
          },
          catch: ensureError,
        });
      },
    );

    const first = ctrl.admitInterruptedFollowUp({ text: 'Resume now.' });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') return;
    await resumeCalled.promise;
    expect(mocks.resumeRun).toHaveBeenCalledOnce();

    expect(ctrl.admitInterruptedFollowUp({ text: 'Route normally.' })).toEqual({
      kind: 'not_interrupted',
    });
    resume.resolve(STARTED);
    await expect(awaitAdmission(first.completion)).resolves.toBe(true);
  });

  it('retains the interrupted conversation after a failed resume', async () => {
    const { ctrl, session } = makeInterruptedController(Effect.void, true);
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    expect(session.interruptedRunId).toBe('a11111');
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
    expect(session.interruptedRunId).toBeUndefined();
  });

  it('discards retained interrupted follow-ups when the chat is cleared', async () => {
    const { ctrl } = makeInterruptedController(Effect.void, true);
    await retainInterruptedFollowUp(ctrl, 'Discard me.');
    ctrl.clearInterruptedRecovery();

    expect(ctrl.admitInterruptedFollowUp({ text: 'Fresh chat.' })).toEqual({
      kind: 'not_interrupted',
    });
  });

  it('keeps retained follow-ups ahead of a retry after manual resume rollback', async () => {
    mocks.setCliHelperModel.mockReturnValueOnce(
      Effect.fail(new Error('load failed')),
    );
    const { ctrl, session } = makeInterruptedController(Effect.void, true);
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    await runResume(ctrl, 'aaaaaa' as RunId);
    // The rollback rides the run chain now that the rehydration runs inside
    // `resumeRun`'s adoption hook, so the retry follows the settled resume.
    await awaitRunSettled(session);
    await expectInterruptedRetry(ctrl, ['First attempt.', 'Retry.']);
  });

  it('keeps the seeded batch when manual resume is refused', async () => {
    const { ctrl, session } = makeInterruptedController(Effect.void, true);
    await retainInterruptedFollowUp(ctrl, 'First attempt.');
    // A refusal that never reaches the follow-up queue hands the seeded batch
    // back; nothing else owns it, so the resume must put it and the
    // interrupted run back or the input typed during the interruption is
    // lost.
    mocks.resumeRun
      .mockReset()
      .mockReturnValueOnce(Effect.succeed({ failed: 'not_resumable' }));

    await runResume(ctrl, 'aaaaaa' as RunId);

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

    await expect(runTryResume(ctrl, child)).resolves.toBe(true);

    expect(rootRunId.get()).toBe(root);
  });

  it('does not auto-resume after stop during helper-model setup', async () => {
    const helperModel = createDeferred<void>();
    const helperModelStarted = createDeferred();
    const session = makeSession({ runCompleted: true });
    const config = makeResumeConfig();
    mocks.setCliHelperModel.mockImplementationOnce(() => {
      helperModelStarted.resolve();
      return Effect.tryPromise(() => helperModel.promise);
    });
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

    const resumed = runTryResume(ctrl, 'a11111' as RunId);
    await helperModelStarted.promise;
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith(
      expect.anything(),
      config.model,
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
