// Unit tests for the chat-session controller's run-slot ownership, stop and
// resume paths, and presentation-host lifecycle. The session's `start` and
// `resume` are stand-ins; the session surfaces the controller reasons about
// (run registry, event hub, run status, host interactions) are the real
// runtime objects wherever a test asserts through them.

import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream,
  SubscriptionRef,
  Context,
} from 'effect';
import { layer } from '@effect/vitest';
import { beforeEach, expect, onTestFinished, vi } from 'vitest';

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
  appendLocalNotice: mocks.appendLocalNotice,
  appendLocalErrorTranscript: mocks.appendLocalErrorTranscript,
  appendLocalUserTranscript: mocks.appendLocalUserTranscript,
  clearLocalTranscript: mocks.clearLocalTranscript,
  moveLocalTranscriptToRun: mocks.moveLocalTranscriptToRun,
  reportRequestDefect: mocks.reportRequestDefect,
}));

import {
  type AgentConfig,
  type AgentConfigPayload,
  ensureError,
  qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
  type RuntimeRequest,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import { Interactions } from '@agent/runtime/HostInteractions';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import type { SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import { rootRunId } from '@cli/chat/tui/state/cliState';
import { currentView } from '@cli/chat/tui/state/sessionView';
import {
  chatTuiCanStartRootRun,
  runStopFacts,
  TuiSession,
  type RootRunSettled,
} from '@cli/chat/tui/state/sessionRunState';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { admitInterruptibleRun } from '@test/support/runHandleFixtures';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import {
  boundTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';
import type { Outcome, Session } from '@texra-ai/harness';

// The state stores the controller's setting reads land on, as ports of a
// fake host installed fresh per test rather than a module mock of
// `platform()`: the setting reads (the team name) take the session's own
// roots, which this file's stub takes from the installed host, and the
// kernel's setup file installs a host before this file's mocks are
// registered.
const hostWithMockedStores = FakeHost.layer(
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
  if (overrides.stopRequested) session.askStop('user');
  return session;
}

/** The claimed root run's result, as the exit drain waits on it. */
function awaitRunSettled(session: TuiSession) {
  return session.runSettled ?? Effect.void;
}

/** A root-run claim the test settles by hand, as a run chain settles it. */
function pendingRunClaim(): {
  readonly settled: RootRunSettled;
  /** Settle the claim, then let the fibers waiting on it run their
   *  continuations before the next assertion reads what they wrote. */
  readonly settle: Effect.Effect<void, Error>;
} {
  const claim = Deferred.makeUnsafe<void, Error>();
  return {
    settled: Deferred.await(claim),
    settle: Effect.suspend(() => {
      Deferred.doneUnsafe(claim, Effect.void);
      return Effect.andThen(Deferred.await(claim), Effect.yieldNow);
    }),
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

/** The controller's init over the block's runtime, as the chat entry builds
 *  it. */
const makeInit = (overrides: Partial<ChatSessionControllerInit> = {}) =>
  Effect.map(SessionGraph.runtime, (runtime): ChatSessionControllerInit => {
    const scope = Scope.makeUnsafe();
    const chatScope = Scope.makeUnsafe();
    onTestFinished(() =>
      Effect.runPromise(
        Effect.andThen(
          Scope.close(chatScope, Exit.void),
          Scope.close(scope, Exit.void),
        ),
      ),
    );
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
      sessionContext: makeSessionContext(),
      chatScope,
      shutdownScope: scope,
      cwd: '/tmp/workspace',
      getSlashCommandContext: () => {
        throw new Error('slash commands are not exercised here');
      },
      stores: makeFakeSettingsStores().stores,
      runtime,
      approvalPolicy: () => undefined,
      ...overrides,
    };
  });

/** The session's view ref, as a value the harness can install. The run lives
 *  in this helper; a test body composes with `yield*` instead. */
const installableViewRef = () =>
  Effect.runSync(SubscriptionRef.make(currentView()));

/**
 * Installs the session stub the controller surfaces receive. Every surface is
 * a stub the controller can call; `sessionStub` is a bare mock, so the
 * override map is untyped here exactly as the returned session is.
 */
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
  const local = yield* TestSession.open();
  const session = yield* sessionHandleOf(local);
  // The real session's request handler admits only runs the fold holds;
  // these cases track runs directly, so the stop request lands on the
  // registry the way the handler would land it.
  const owner: Session = {
    ...local,
    // cast: every request this stub takes is answered `done`.
    request: ((req: RuntimeRequest) =>
      Effect.gen(function* (): Effect.fn.Return<Outcome> {
        if (req.kind === 'run.stop') {
          yield* Context.get(session, Runs)
            .stop(req.runId, {
              detachActiveChildren: req.detachActiveChildren ?? undefined,
              reason: req.reason,
            })
            .settlement // The handler words a refused stop as a request error; this
            // stub has no such vocabulary, so a refusal is a defect here.
            .pipe(Effect.orDie, Effect.provide(session));
        }
        return { kind: 'done' };
      })) as Session['request'],
  };
  mocks.sessionStub.mockReturnValue({
    ...owner,
    start: mocks.rootLaunch,
    resume: mocks.resumeRun,
  });
  return {
    session,
    runs: registryOf(Context.get(session, Runs)),
    interactions: Context.get(session, Interactions),
  };
});
/** A resumed run whose result reads `outcome` when the chat awaits it. */
const resumedRun = (
  runId: RunId,
  outcome: () => RunOutcome = () => RUN_OUTCOME.COMPLETED,
) => ({ runId, result: Effect.sync(() => ({ outcome: outcome() })) });

// Live clock: the controller's stops and resumes settle on real event-loop
// turns. The view is bound for the block; the host with the mocked stores is
// fresh per test, as the stub's roots read it.
layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('createChatSessionController', (it) => {
  it.layer(hostWithMockedStores, { buildPerTest: true })((it) => {
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
      // The durable run record `resume()` resolves before adopting the run.
      mocks.getRunRecords.mockReturnValue({
        readConfig: async () =>
          ({ agent: 'demo-agent', model: 'demo-model' }) as AgentConfig,
        exists: async () => true,
      });
      seedView(viewWith([]));
      rootRunId.set(undefined);
    });

    it.effect(
      'keeps detached-child approvals answerable after the stopped root finalizes',
      () =>
        Effect.gen(function* () {
          const childRun = 'c00001' as RunId;
          let childLaunch: Fiber.Fiber<void> | undefined;
          const { session: runtimeSession, runs } =
            yield* installOwnerSession();
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

          const rootRunResult = createDeferred<{
            runId: RunId;
            outcome: typeof RUN_OUTCOME.CANCELLED;
          }>();
          // The launch mints the root run id, so the fixture takes it from the
          // launch instead of naming one of its own.
          mocks.executeAgent.mockImplementationOnce(
            async (_config: unknown, runId: RunId) => {
              // A launch states both runs in the plane before it launches them:
              // the stop publishes `run.detach` on the child's own aggregate, and
              // a run aggregate opens with its `run.start` and nothing else.
              publishTestRunStart(runtimeSession, runId);
              publishTestRunStart(runtimeSession, childRun, { parent: runId });
              // The root run's stop is its registry fiber's interruption: the
              // stop lands there, and the run resolves cancelled through its own
              // result.
              admitInterruptibleRun(runs, runId, () => {
                rootRunResult.resolve({
                  runId,
                  outcome: RUN_OUTCOME.CANCELLED,
                });
              });
              childLaunch = admitInterruptibleRun(
                runs,
                childRun,
                () => {},
                runId,
              );
              return rootRunResult.promise;
            },
          );

          const session = makeSession();
          const chatScope = Scope.makeUnsafe();
          const shutdownScope = Scope.makeUnsafe();
          const ctrl = createChatSessionController(
            yield* makeInit({ session, chatScope, shutdownScope }),
          );
          yield* Effect.forkChild(
            ctrl.startRootRun(makeRunRequest('Delegate the calculation.')),
            { startImmediately: true },
          );
          const rootRun = session.runId;
          if (!rootRun) throw new Error('startRootRun did not claim a run id');
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(runs.get(childRun)).toBeDefined()),
          );

          // The launch's `run.start` rows are detached publishes: the stop
          // claims the child's aggregate, so they commit first.
          yield* Context.get(runtimeSession, SessionLog).settled;
          // The stop Ctrl-C sends under "Keep subagents running": the root
          // stops and its live children detach.
          const owner = mocks.sessionStub() as Session;
          yield* owner.request({
            kind: 'run.stop',
            runId: rootRun,
            detachActiveChildren: true,
            reason: 'user',
          });
          yield* awaitRunSettled(session);

          expect(session.runCompleted).toBe(true);
          // The local sever follows the committed `run.detach` now, so the
          // promotion lands with that batch rather than with the stop's admission.
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                Context.get(runtimeSession, SessionViewAccess).run(childRun)
                  ?.parentId,
              ).toBeNull(),
            ),
          );

          // The request opens on the child's own aggregate, which the launch
          // already stated in the plane.
          const requestId = 'bash-detached-child';
          const approval = yield* Effect.forkScoped(
            Context.get(runtimeSession, SessionRequests).ask(childRun, {
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
                SubscriptionRef.getUnsafe(
                  Context.get(runtimeSession, SessionViewAccess).ref,
                ).requests.map((request) => request.requestId),
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
          if (childLaunch) yield* Fiber.interrupt(childLaunch);
          expect(disposeAdapter).not.toHaveBeenCalled();

          yield* Scope.close(chatScope, Exit.void);
          expect(disposeAdapter).toHaveBeenCalledOnce();
          yield* Scope.close(shutdownScope, Exit.void);
          expect(mocks.presentationHostClose).toHaveBeenCalledOnce();
          runs.dispose();
        }),
    );

    it.effect(
      'stops the resumed run for a Ctrl-C issued while resume() is still settling',
      () =>
        Effect.gen(function* () {
          // The early slot claim makes this resume() interruptible as soon as
          // the session admits the run: a Ctrl-C in that window lands on the
          // resumed run, which ends cancelled, rather than leaving it running.
          const rehydrated = createDeferred<void>();
          const session = makeSession({ runCompleted: true });
          // A resumed run the chat stopped through its session ends cancelled.
          const stops: RunId[] = [];
          mocks.request.mockImplementation((req: RuntimeRequest) =>
            Effect.sync((): Outcome => {
              if (req.kind === 'run.stop') stops.push(req.runId);
              return { kind: 'done' };
            }),
          );
          mocks.resumeRun.mockImplementationOnce((id: RunId) => {
            const run = resumedRun(id, () =>
              stops.includes(id)
                ? RUN_OUTCOME.CANCELLED
                : RUN_OUTCOME.COMPLETED,
            );
            return Effect.succeed({
              ...run,
              result: Effect.andThen(
                Effect.promise(() => rehydrated.promise),
                run.result,
              ),
            });
          });
          const ctrl = createChatSessionController(
            yield* makeInit({ session }),
          );

          // A stop lands only on a run the fold holds.
          seedView(viewWith([makeRunView({ id: 'aaaaaa' as RunId })]));
          // The resume command, run the way the Ink handler runs it.
          const resumed = yield* Effect.forkChild(
            ctrl.resume('aaaaaa' as RunId),
            { startImmediately: true },
          );
          // resume() has claimed the slot synchronously; once the durable
          // record resolves it suspends inside the resume, after adoption, with
          // session.runId already set to the resumed run.
          expect(session.runSettled).toBeDefined();
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(session.runId).toBe('aaaaaa')),
          );
          // #8273 regression: the controller must publish the run facts so
          // status rendering can derive the Ctrl-C hint from signals instead
          // of calling impure session closures that memoized renders cache
          // stale.
          expect(runStopFacts.get().runPending).toBe(true);
          expect(runStopFacts.get().runId).toBe('aaaaaa');

          // Ctrl-C fires while resume() is still rehydrating.
          ctrl.stop('user');

          rehydrated.resolve();
          yield* Fiber.join(resumed);
          yield* awaitRunSettled(session);

          expect(session.runExitCode).toBe(CliExitCode.Interrupted);
          expect(session.runCompleted).toBe(true);
        }),
    );

    it.effect(
      'sends messages typed while a stop settles to the session in order, and hands the slot to the continued run',
      () =>
        Effect.gen(function* () {
          // Typed while the stop settles: both go to the session's own
          // admission for that run at once, in order; the session waits for
          // the stop and resumes the run. A served chat observes no resumes:
          // once the stopped run's claim lets go, the slot passes to the
          // continued run, so a later message cannot start a second root
          // beside it.
          seedView(viewWith([makeRunView({ id: 'a11111' as RunId })]));
          installSession({ view: installableViewRef() });
          const teardown = pendingRunClaim();
          const session = makeSession({
            runId: 'a11111' as RunId,
            runSettled: teardown.settled,
            stopRequested: true,
          });
          const ctrl = createChatSessionController(
            yield* makeInit({
              session,
              served: true,
              getSlashCommandContext: () => ({}) as SlashCommandContext,
            }),
          );
          const sent: string[] = [];
          mocks.request.mockImplementation((req: RuntimeRequest) =>
            Effect.sync((): Outcome => {
              if (req.kind === 'followUp.send')
                sent.push(`${req.runId} ${req.text}`);
              return {
                kind: 'followUp',
                id: 'sent-1',
                status: 'queued',
                receipt: { state: 'accepted' },
              };
            }),
          );

          // The composer's submit path, run the way the composer runs it.
          yield* ctrl.submit('Do not drop this message.');
          yield* ctrl.submit('And this one.');
          expect(sent).toEqual([
            'a11111 Do not drop this message.',
            'a11111 And this one.',
          ]);

          session.markRunCompleted(teardown.settled);
          yield* teardown.settle;
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(chatTuiCanStartRootRun(session)).toBe(false),
            ),
          );
          expect(mocks.executeAgent).not.toHaveBeenCalled();
          expect(session.runId).toBe('a11111');
        }),
    );

    it.effect(
      'frees the slot of a continuation that ended before the chat looked',
      () =>
        Effect.gen(function* () {
          // The resumed turn ran and ended before the chat's adoption read the
          // fold: no level it reads shows the run live, yet the run did
          // continue.
          seedView(
            viewWith([
              makeRunView({
                id: 'a11111' as RunId,
                status: RUN_OUTCOME.CANCELLED,
                turn: 1,
                resumeBlocked: null,
              }),
            ]),
          );
          rootRunId.set('a11111' as RunId);
          const view = installableViewRef();
          installSession({ view });
          const session = makeSession({ runId: 'a11111' as RunId });
          const ctrl = createChatSessionController(
            yield* makeInit({
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
              return {
                kind: 'followUp',
                id: 'sent-1',
                status: 'sent',
                receipt: { state: 'accepted' },
              };
            }),
          );

          yield* ctrl.submit('Carry on.');

          expect(mocks.request).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'followUp.send', runId: 'a11111' }),
          );
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(chatTuiCanStartRootRun(session)).toBe(true),
            ),
          );
        }),
    );
  });
});
