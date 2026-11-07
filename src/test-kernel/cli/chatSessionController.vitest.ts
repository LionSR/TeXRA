// Unit tests for the chat-session controller's run-slot ownership and its
// stop and resume paths. The session's `start` and `resume` are stand-ins.

import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
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

vi.mock('@cli/runtime/platform/initPlatform', () => ({
  setCliHelperModel: mocks.setCliHelperModel,
}));

vi.mock('@cli/runtime/headless/cliPresentationHost', () => ({
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
  AgentConfigSchema,
  ensureError,
  RUN_OUTCOME,
  RunIdSchema,
  type RunId,
  type RunOutcome,
  type RuntimeCommand,
  type SessionView,
} from '@texra-ai/harness/schemas';
import type { CliContext } from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import type { SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import { slashCommands } from '@cli/chat/tui/commands/slashRegistry';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import { EMPTY_DRAFT } from '@cli/chat/tui/input/draftAttachments';
import { rootRunId } from '@cli/chat/tui/state/cliState';
import { currentView } from '@cli/chat/tui/state/sessionView';
import {
  chatTuiCanStartRootRun,
  runStopFacts,
  TuiSession,
  type RootRunSettled,
} from '@cli/chat/tui/state/sessionRunState';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import {
  boundTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';
import type { Outcome } from '@texra-ai/harness';

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
}

function makeSession(overrides: SessionFixture = {}): TuiSession {
  const session = new TuiSession();
  if (overrides.runSettled)
    session.markRunPending(overrides.runSettled, Effect.void);
  if (overrides.runCompleted && overrides.runSettled)
    session.markRunCompleted(overrides.runSettled);
  if (overrides.runId) session.runId = overrides.runId;
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
      draft: runtime.runSync(SubscriptionRef.make(EMPTY_DRAFT)),
      modelConnection: { connected: Effect.void, open: Effect.succeed(false) },
      ...overrides,
    };
  });

const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);

/** The session's view ref, as a value the harness can install. The run lives
 *  in this helper; a test body composes with `yield*` instead. */
const installableViewRef = () =>
  Effect.runSync(SubscriptionRef.make(currentView()));

/**
 * Installs the session stub the controller surfaces receive. Every surface is
 * a stub the controller can call; the view's changes stream from `installed`
 * when the case gives one.
 */
function installSession(
  installed?: SubscriptionRef.SubscriptionRef<SessionView>,
): void {
  const ref = installed ?? installableViewRef();
  mocks.sessionStub.mockReturnValue({
    roots: testWorkspaceRoots(),
    // The run's records the chat reads: its saved setup, whether it exists.
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
  });
}
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
          Schema.decodeUnknownSync(AgentConfigSchema)({
            agent: 'demo-agent',
            model: 'demo-model',
          }),
        exists: async () => true,
      });
      seedView(viewWith([]));
      rootRunId.set(undefined);
    });

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
          mocks.request.mockImplementation((req: RuntimeCommand) =>
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
          seedView(viewWith([makeRunView({ id: decodeRunId('aaaaaa') })]));
          // The resume command, run the way the Ink handler runs it.
          const resumed = yield* Effect.forkChild(
            ctrl.resume(decodeRunId('aaaaaa')),
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

          expect(session.exitCode).toBe(CliExitCode.Interrupted);
          expect(session.runCompleted).toBe(true);
        }),
    );

    it.effect(
      'a run that fails while the chat is leaving exits as a failure',
      () =>
        Effect.gen(function* () {
          // The quit does not make a failure a success: the exit code is the
          // claim's, written before anything asks whether the chat is leaving.
          const session = makeSession({ runCompleted: true });
          mocks.request.mockImplementation(() =>
            Effect.sync((): Outcome => ({ kind: 'done' })),
          );
          const failing = createDeferred<void>();
          mocks.resumeRun.mockImplementationOnce((id: RunId) =>
            Effect.succeed({
              runId: id,
              result: Effect.andThen(
                Effect.promise(() => failing.promise),
                Effect.fail(new Error('the model call failed')),
              ),
            }),
          );
          const ctrl = createChatSessionController(
            yield* makeInit({ session }),
          );
          seedView(viewWith([makeRunView({ id: decodeRunId('aaaaaa') })]));
          const resumed = yield* Effect.forkChild(
            ctrl.resume(decodeRunId('aaaaaa')),
            { startImmediately: true },
          );
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(session.runId).toBe('aaaaaa')),
          );
          // The user quits while the run still works; its failure lands after.
          session.exited = Promise.resolve(CliExitCode.Success);
          failing.resolve();
          yield* Fiber.join(resumed);
          yield* Effect.exit(awaitRunSettled(session));

          expect(session.exitCode).toBe(CliExitCode.AgentError);
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
          seedView(viewWith([makeRunView({ id: decodeRunId('a11111') })]));
          installSession(installableViewRef());
          const teardown = pendingRunClaim();
          const session = makeSession({
            runId: decodeRunId('a11111'),
            runSettled: teardown.settled,
          });
          const ctrl = createChatSessionController(
            yield* makeInit({
              session,
              served: true,
              // cast: these plain messages match no slash command, so only the
              // empty table is read.
              getSlashCommandContext: () =>
                ({ commands: slashCommands([]) }) as SlashCommandContext,
            }),
          );
          const sent: string[] = [];
          mocks.request.mockImplementation((req: RuntimeCommand) =>
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
          yield* ctrl.submit({
            ...EMPTY_DRAFT,
            text: 'Do not drop this message.',
          });
          yield* ctrl.submit({ ...EMPTY_DRAFT, text: 'And this one.' });
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
  });
});
