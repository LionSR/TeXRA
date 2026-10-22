// Unit tests for the chat-session controller's run-slot ownership, stop and
// resume paths, and presentation-host lifecycle. The session's `start` and
// `resume` are stand-ins; the session surfaces the controller reasons about
// (run registry, event hub, run status, host interactions) are the real
// runtime objects wherever a test asserts through them.

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Scope,
  Stream,
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
  rootLaunch: vi.fn(),
  request: vi.fn(),
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
  createTuiHostInteractions: vi.fn(),
  resumeRun: vi.fn(),
  appendLocalNotice: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
  clearLocalTranscript: vi.fn(),
  moveLocalTranscriptToRun: vi.fn(),
  reportRequestDefect: vi.fn(),
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
  appendLocalNotice: mocks.appendLocalNotice,
  appendLocalErrorTranscript: mocks.appendLocalErrorTranscript,
  appendLocalUserTranscript: mocks.appendLocalUserTranscript,
  clearLocalTranscript: mocks.clearLocalTranscript,
  moveLocalTranscriptToRun: mocks.moveLocalTranscriptToRun,
  reportRequestDefect: mocks.reportRequestDefect,
}));

import { ResumeRefused, type Session } from '@texra-ai/harness';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { registryOf } from '@agent/runtime/runRegistry';
import type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
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
import {
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { untrackRun } from '@test/support/sessionEnd';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import {
  admitInterruptibleRun,
  testRunHandle,
} from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import { DisposableStore } from '@texra/platform/disposable';
import { ensureError } from '@utils/errors/errorMessage';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';
import type { SessionView } from '@texra-ai/harness/schemas';

// The state stores the controller's setting reads land on, as ports of the
// installed fake host rather than a module mock of `platform()`: the setting
// reads (the team name) take the session's own roots, which this
// file's stub takes from the installed host, and the kernel's setup file
// installs a host before this file's mocks are registered.
setupPlatform(
  {},
  {
    globalState: {
      get: mocks.globalGet,
      update: () => Effect.void,
      modify: () => Effect.die(new Error('unused')),
    },
    workspaceState: {
      get: mocks.workspaceGet,
      update: () => Effect.void,
      modify: () => Effect.die(new Error('unused')),
    },
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
  const session = new TuiSession();
  if (overrides.runSettled) session.markRunPending(overrides.runSettled);
  if (overrides.runCompleted && overrides.runSettled)
    session.markRunCompleted(overrides.runSettled);
  if (overrides.runId) session.runId = overrides.runId;
  session.interruptedRunId = overrides.interruptedRunId;
  if (overrides.stopRequested) session.askStop('user');
  return session;
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
    model: 'openai/gpt-5.4-2026-03-05',
    instruction,
    workingDirectory: '/tmp/test',
  };
}

type ToolUseRunResult<Outcome> = {
  runId: RunId;
  outcome: Outcome;
};

function makeInit(
  overrides: Partial<ChatSessionControllerInit> = {},
): ChatSessionControllerInit {
  const scope = Scope.makeUnsafe();
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return {
    // Only when the test brings none: a new session resets the one claim.
    session: overrides.session ?? makeSession(),
    runSession: mocks.sessionStub(),
    served: false,
    records: (runId: RunId) => {
      const records = mocks.getRunRecords(runId);
      return {
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
    getSessionContext: () => makeSessionContext(),
    disposables: new DisposableStore(),
    shutdownScope: scope,
    followUpQueue: Effect.runSync(makeFollowUpDeliveryQueue(scope)),
    cwd: '/tmp/workspace',
    getSlashCommandContext: () => {
      throw new Error('slash commands are not exercised here');
    },
    secrets: new FakeSecrets(),
    stores: makeFakeSettingsStores('cli').stores,
    runtime: testRuntime(),
    approvalPolicy: () => undefined,
    ...overrides,
  };
}

function makeResumeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent: 'demo-agent',
    model: 'demo-model',
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
  const { view: installed, ...rest } = overrides;
  const ref =
    (installed as SubscriptionRef.SubscriptionRef<SessionView> | undefined) ??
    installableViewRef();
  mocks.sessionStub.mockReturnValue({
    roots: testWorkspaceRoots(),
    // The chat's host attaches for the session's life; detaching it is the
    // stub's own mock.
    attach: vi.fn(() =>
      Effect.addFinalizer(() => Effect.sync(mocks.detachHostInteractions)),
    ),
    request: mocks.request,
    start: mocks.rootLaunch,
    resume: mocks.resumeRun,
    // The fold's level and its stream, over whichever view ref the case
    // installed.
    view: {
      current: () => SubscriptionRef.getUnsafe(ref),
      changes:
        installed === undefined ? Stream.empty : SubscriptionRef.changes(ref),
      watch: () => Stream.empty,
    },
    ...rest,
  });
}

/**
 * Installs a session whose interaction, event, status, and run surfaces
 * are the real runtime objects rather than per-mock stubs.
 */
const installOwnerSession = Effect.fn('installOwnerSession')(function* () {
  const session = yield* createTestSession();
  // The real session's request handler admits only runs the fold holds;
  // these cases track runs directly, so the stop request lands on the
  // registry the way the handler would land it.
  const owner: Session = {
    ...testSessionOf(session),
    request: (req: RuntimeRequest) =>
      Effect.gen(function* (): Effect.fn.Return<Outcome> {
        if (req.kind === 'run.stop') {
          yield* session.runs
            .stop(req.runId, {
              detachActiveChildren: req.detachActiveChildren ?? undefined,
              reason: req.reason,
            })
            .settlement // The handler words a refused stop as a request error; this
            // stub has no such vocabulary, so a refusal is a defect here.
            .pipe(Effect.orDie);
        }
        return { kind: 'done' };
      }),
  };
  mocks.sessionStub.mockReturnValue({
    ...owner,
    start: mocks.rootLaunch,
    resume: mocks.resumeRun,
  });
  return {
    session,
    runs: registryOf(session.runs),
    interactions: session.interactions,
  };
});
/**
 * A stop lands only on a run the fold holds, so a test that stops one states
 * it in the view first.
 */
function holdRun(runId: RunId): void {
  seedView(viewWith([makeRunView({ id: runId })]));
}

/** The stops the chat asked of each run through its session, recorded by
 *  {@link recordStops}: a resumed run the chat stopped ends cancelled. */
const recordStops = (): RunId[] => {
  const stops: RunId[] = [];
  mocks.request.mockImplementation((req: RuntimeRequest) =>
    Effect.sync((): Outcome => {
      if (req.kind === 'run.stop') stops.push(req.runId);
      return { kind: 'done' };
    }),
  );
  return stops;
};

/** A resumed run whose result reads `outcome` when the chat awaits it. */
const resumedRun = (
  runId: RunId,
  outcome: () => RunOutcome = () => RUN_OUTCOME.COMPLETED,
) => ({ runId, result: Effect.sync(() => ({ outcome: outcome() })) });

/** A resumed run that ends cancelled once the chat stopped it. */
const stoppableRun = (runId: RunId, stops: readonly RunId[]) =>
  resumedRun(runId, () =>
    stops.includes(runId) ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.COMPLETED,
  );

describe('CLI terminal outcome resolution', () => {
  // The persisted outcome is a committed `run.end` row on a real session over
  // the fake platform's storage; the read path under test folds it, so no
  // record store is stubbed.
  it.effect('prefers the persisted post-shutdown outcome', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      const runId = '5d0001' as RunId;
      publishTestRunStart(session, runId);
      publishTestRows(session, [
        {
          type: 'run.end',
          aggregateId: qualifyAggregateId('run', runId),
          outcome: RUN_OUTCOME.CANCELLED,
          output: emptyRunEndOutput(),
        },
      ]);
      yield* session.log.settled;

      expect(
        yield* readCliRunOutcomeState(
          testSessionOf(session),
          {
            outcome: RUN_OUTCOME.COMPLETED,
            output: { response: '', files: [] },
            runId,
          },
          (error) => expect.unreachable(error.message),
        ),
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
        const session = yield* createTestSession();
        const runId = 'b0f001' as RunId;
        publishTestRunStart(session, runId);
        yield* session.log.settled;
        const reportReadFailure = vi.fn();
        // The read fails the way a corrupt store fails it: through the
        // session's own records port, typed.
        vi.spyOn(session.log, 'records').mockReturnValue(
          Effect.fail(
            new DatabaseReadFailed({
              path: 'run-records',
              cause: new Error('metadata read failed'),
            }),
          ),
        );
        vi.spyOn(session.log, 'rows').mockReturnValue(
          Effect.fail(
            new DatabaseReadFailed({
              path: 'run-records',
              cause: new Error('metadata read failed'),
            }),
          ),
        );

        expect(
          yield* readCliRunOutcomeState(
            testSessionOf(session),
            {
              outcome: RUN_OUTCOME.COMPLETED,
              output: { response: '', files: [] },
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
      runId: 'e50001',
      outcome: RUN_OUTCOME.COMPLETED,
    });
    mocks.rootLaunch.mockImplementation(
      (input: { config: unknown; runId: RunId }) =>
        Effect.succeed({
          runId: input.runId,
          result: Effect.tryPromise({
            try: () => mocks.executeAgent(input.config, input.runId),
            catch: ensureError,
          }),
        }),
    );
    // Return the caller-provided default (undefined for workspace agents keys) — a
    // blanket `false` is not a valid persisted value for
    // WORKSPACE_AGENTS, which agent resolution now reads.
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
    mocks.createTuiHostInteractions.mockReturnValue({});
    mocks.request.mockImplementation(() =>
      Effect.succeed<Outcome>({ kind: 'done' }),
    );
    mocks.reportRequestDefect.mockReturnValue(
      Effect.succeed('The request failed inside TeXRA; see the log.'),
    );
    installSession();
    mocks.resumeRun.mockImplementation((runId: RunId) =>
      Effect.succeed(resumedRun(runId)),
    );
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
    ctrl.stop('user');
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
        const { session: runtimeSession, runs } = yield* installOwnerSession();
        const disposeAdapter = vi.fn();
        const presentationHost = {
          emit: vi.fn(),
          close: mocks.presentationHostClose,
          attachRunProgressRenderer: vi.fn(() => Effect.void),
        } as unknown as CliRuntimeHost;
        mocks.createCliRuntimeHost.mockReturnValue(presentationHost);
        mocks.createTuiHostInteractions.mockReturnValue({
          dispose: disposeAdapter,
        });

        const rootRunResult =
          createDeferred<ToolUseRunResult<typeof RUN_OUTCOME.CANCELLED>>();
        // The launch mints the root run id, so the fixture takes it from the
        // launch instead of naming one of its own.
        mocks.executeAgent.mockImplementationOnce(
          async (_config: unknown, runId: RunId) => {
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
            // The root run's stop is its registry fiber's interruption: the
            // stop lands there, untracks the root, and the run resolves
            // cancelled through its own result.
            admitInterruptibleRun(runs, runId, () => {
              untrackRun(runs, runId);
              rootRunResult.resolve({
                runId,
                outcome: RUN_OUTCOME.CANCELLED,
              });
            });
            return rootRunResult.promise;
          },
        );

        const session = makeSession();
        const disposables = new DisposableStore();
        const shutdownScope = Scope.makeUnsafe();
        const ctrl = createChatSessionController(
          makeInit({ session, disposables, shutdownScope }),
        );
        ctrl.startRootRun(makeRunRequest('Delegate the calculation.'));
        const rootRun = session.runId;
        if (!rootRun) throw new Error('startRootRun did not claim a run id');
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(runs.get(childRun)?.handle).toBeDefined()),
        );

        // The launch's `run.start` rows are detached publishes: the stop
        // claims the child's aggregate, so they commit first.
        yield* runtimeSession.log.settled;
        // The stop Ctrl-C sends under "Keep subagents running": the root
        // stops and its live children detach.
        const owner = mocks.sessionStub() as Session;
        yield* owner.request({
          kind: 'run.stop',
          runId: rootRun,
          detachActiveChildren: true,
          reason: 'user',
        });
        yield* Effect.promise(() => awaitRunSettled(session));

        expect(session.runCompleted).toBe(true);
        // The local sever follows the committed `run.detach` now, so the
        // promotion lands with that batch rather than with the stop's admission.
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(runs.parentOf(childRun)).toBeNull()),
        );
        expect(disposeAdapter).not.toHaveBeenCalled();
        expect(mocks.presentationHostClose).not.toHaveBeenCalled();

        // The request opens on the child's own aggregate, which the launch
        // already stated in the plane.
        const requestId = 'bash-detached-child';
        const approval = yield* Effect.forkScoped(
          runtimeSession.requests.ask(childRun, {
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
              SubscriptionRef.getUnsafe(runtimeSession.view.ref).requests.map(
                (request) => request.requestId,
              ),
            ).toEqual([requestId]),
          ),
        );
        publishTestRows(runtimeSession, [
          {
            type: 'request.decided',
            aggregateId: qualifyAggregateId('run', childRun),
            requestId,
            decision: { action: 'approve' },
          },
        ]);
        expect(yield* Fiber.join(approval)).toEqual({ action: 'approve' });

        // The host lives for the chat session, not for the runs it served.
        untrackRun(runs, childRun);
        expect(disposeAdapter).not.toHaveBeenCalled();

        disposables.dispose();
        expect(disposeAdapter).toHaveBeenCalledOnce();
        yield* Scope.close(shutdownScope, Exit.void);
        expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
        runs.dispose();
      }),
  );

  it('reports a fresh-run defect and settles its claimed run slot', async () => {
    mocks.rootLaunch.mockReturnValueOnce(
      Effect.die(new Error('launch defect')),
    );
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
    mocks.rootLaunch.mockReturnValueOnce(
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
    // resume() ever reaches its first await.
    expect(session.runSettled).toBeDefined();
    expect(session.runCompleted).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);

    configRead.resolve(null);
    await resumed;
    expect(session.runCompleted).toBe(true);
  });

  it('retains the configuration of a manually resumed conversation', async () => {
    const config = makeResumeConfig({
      cli: { teamId: 'physicist' },
      delegationAgentScope: ['builtIn:physicsReviewer', 'builtIn:orchestrator'],
    });
    installResumeRunStore(config);
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));

    await runResume(ctrl, 'ec0001' as RunId);
    await awaitRunSettled(session);

    expect(sessionMeta.get()).toMatchObject({
      teamName: 'Physicist',
      cliTeamId: 'physicist',
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
        cliTeamId: 'mathematician',
        delegationAgentScope: ['custom:current'],
      });
      const previousMetadata = sessionMeta.get();
      installResumeRunStore(makeResumeConfig({ cli: { teamId: 'physicist' } }));
      // Both runtime refusals precede the hook that adopts the target run.
      // The session's refusal, in its words.
      mocks.resumeRun.mockReturnValueOnce(
        Effect.fail(
          new ResumeRefused({
            runId: 'ec0001',
            reason: failure,
            message: describeFollowUpFailure(failure),
          }),
        ),
      );
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
  });

  it('stops the resumed run for a Ctrl-C issued while resume() is still settling', async () => {
    // The early slot claim makes this resume() interruptible as soon as the
    // session admits the run: a Ctrl-C in that window lands on the resumed
    // run, which ends cancelled, rather than leaving it running.
    const rehydrated = createDeferred<void>();
    const session = makeSession({
      interruptedRunId: 'e11111' as RunId,
      runCompleted: true,
    });
    const stops = recordStops();
    mocks.resumeRun.mockImplementationOnce((id: RunId) => {
      const run = stoppableRun(id, stops);
      return Effect.succeed({
        ...run,
        result: Effect.andThen(
          Effect.promise(() => rehydrated.promise),
          run.result,
        ),
      });
    });
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
    ctrl.stop('user');
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
    // window before `onAdmitted` has no run to mark: without the
    // re-read at adoption the user's Ctrl-C would leave no recoverable
    // conversation, and any stale run it did find would be the wrong one.
    const resumeReached = createDeferred<void>();
    const resumeStarted = createDeferred();
    const session = makeSession({
      runId: 'd00001' as RunId,
      runCompleted: true,
    });
    const stops = recordStops();
    mocks.resumeRun.mockImplementationOnce((id: RunId) => {
      resumeStarted.resolve();
      return Effect.as(
        Effect.promise(() => resumeReached.promise),
        stoppableRun(id, stops),
      );
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    holdRun('aaaaaa' as RunId);
    const resumed = runResume(ctrl, 'aaaaaa' as RunId);
    await resumeStarted.promise;
    expect(mocks.resumeRun).toHaveBeenCalledOnce();
    ctrl.stop('user');
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
    holdRun('aaaaaa' as RunId);
    const stops = recordStops();
    mocks.resumeRun.mockImplementationOnce((id: RunId) => {
      resumeCalled.resolve();
      return Effect.succeed(stoppableRun(id, stops));
    });

    const resumeStarted = runResume(ctrl, 'aaaaaa' as RunId);
    await helperModelStarted.promise;
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith(
      expect.anything(),
      'demo-model',
    );

    ctrl.stop('user');
    helperModel.resolve(undefined);

    await resumeStarted;
    await resumeCalled.promise;
    // The stop asked during setup lands on the run once it is admitted.
    expect(stops).toEqual(['aaaaaa']);
    await awaitRunSettled(session);
    expect(session.runExitCode).toBe(CliExitCode.Interrupted);
  });

  it('continues the stopped conversation through the session, in order, once the stopped generation settles', async () => {
    // Typed while the stop settles: the first waits for the stopped
    // generation, then goes to the session's own admission for that run; the
    // admission resumed it, so the second goes to the resumed run directly,
    // never waiting on its drain. The chat keeps no copy of either. A served
    // chat observes no resumes: the slot passes to the resumed run, so a
    // later message cannot start a second root beside it.
    holdRun('a11111' as RunId);
    // The stopped generation is no longer live here: the view says so.
    installSession({ view: installableViewRef() });
    const teardown = pendingRunClaim();
    const session = makeSession({
      runId: 'a11111' as RunId,
      interruptedRunId: 'a11111' as RunId,
      runSettled: teardown.settled,
      stopRequested: true,
    });
    const ctrl = createChatSessionController(
      makeInit({
        session,
        served: true,
        getSlashCommandContext: () => ({}) as SlashCommandContext,
      }),
    );
    const sent: string[] = [];
    mocks.request.mockImplementation((req: RuntimeRequest) =>
      Effect.sync((): Outcome => {
        if (req.kind === 'followUp.send') sent.push(`${req.runId} ${req.text}`);
        return { kind: 'followUp', status: 'queued' };
      }),
    );

    await runSubmit(ctrl, 'Do not drop this message.');
    await runSubmit(ctrl, 'And this one.');
    expect(sent).toEqual([]);

    session.markRunCompleted(teardown.settled);
    await teardown.settle();
    await vi.waitFor(() =>
      expect(sent).toEqual([
        'a11111 Do not drop this message.',
        'a11111 And this one.',
      ]),
    );
    expect(mocks.executeAgent).not.toHaveBeenCalled();
    expect(session.interruptedRunId).toBeUndefined();
    expect(session.runId).toBe('a11111');
    expect(chatTuiCanStartRootRun(session)).toBe(false);
  });

  it('frees the slot of a continuation that ended before the chat looked', async () => {
    // The resumed turn ran and ended before the chat's adoption read the
    // fold: no level it reads shows the run live, yet the run did continue.
    holdRun('a11111' as RunId);
    const view = installableViewRef();
    installSession({ view });
    const session = makeSession({
      runId: 'a11111' as RunId,
      interruptedRunId: 'a11111' as RunId,
    });
    const ctrl = createChatSessionController(
      makeInit({
        session,
        served: true,
        getSlashCommandContext: () => ({}) as SlashCommandContext,
      }),
    );
    mocks.request.mockImplementation((req: RuntimeRequest) =>
      Effect.gen(function* (): Effect.fn.Return<Outcome> {
        if (req.kind === 'followUp.send')
          yield* SubscriptionRef.set(
            view,
            viewWith([
              makeRunView({
                id: 'a11111' as RunId,
                status: RUN_OUTCOME.COMPLETED,
                durableOutcome: RUN_OUTCOME.COMPLETED,
              }),
            ]),
          );
        return { kind: 'followUp', status: 'sent' };
      }),
    );

    await runSubmit(ctrl, 'Carry on.');

    await vi.waitFor(() => expect(chatTuiCanStartRootRun(session)).toBe(true));
    expect(session.interruptedRunId).toBeUndefined();
  });
});
