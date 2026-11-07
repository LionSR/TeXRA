// Unit tests for the chat-session controller's run-slot ownership and its
// stop and resume paths. The session's `start` and `resume` are stand-ins.

import {
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
import { assert, beforeEach, expect, onTestFinished, vi } from 'vitest';

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
  canStopRootRun,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  boundTestSessionView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';
import type { Outcome } from '@texra-ai/harness';

// The state stores the controller's setting reads land on, as ports of a
// fake host built fresh per test rather than a module mock of
// `platform()`: the setting reads (the team name) take the session's own
// roots, which this file's stub takes from the test's host.
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

/** `runId`'s level ended: nothing here drives it any more, and its end
 *  stored `outcome`, or none when the end was lost. */
const endedView = (runId: RunId, outcome: RunOutcome | null): SessionView => {
  const view = currentView();
  const run = view.runs.get(runId);
  assert(run !== undefined);
  return {
    ...view,
    runs: new Map([
      ...view.runs,
      [runId, { ...run, holder: 'none', position: 'ready', outcome }],
    ]),
  };
};

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
  Effect.gen(function* () {
    const { roots } = yield* FakeHost;
    const runtime = yield* SessionGraph.runtime;
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
    const init: ChatSessionControllerInit = {
      // Only when the test brings none: a new session resets the one launch.
      session: overrides.session ?? new TuiSession(),
      runSession: mocks.sessionStub(roots),
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
    return init;
  });

const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);

/** The session's view ref, as a value the harness can install. The run lives
 *  in this helper; a test body composes with `yield*` instead. */
const installableViewRef = () =>
  Effect.runSync(SubscriptionRef.make(currentView()));

/**
 * Installs the session stub the controller surfaces receive, over the roots
 * the init hands it (the test's host's). Every surface is a stub the
 * controller can call; the view's level and changes stream from `installed`
 * when the case gives one, else its level is the one the TUI shows and it
 * streams no changes.
 */
function installSession(
  installed?: SubscriptionRef.SubscriptionRef<SessionView>,
): void {
  const current = () =>
    installed === undefined
      ? currentView()
      : SubscriptionRef.getUnsafe(installed);
  mocks.sessionStub.mockImplementation((roots: WorkspaceRoots) => ({
    roots,
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
      current,
      changes:
        installed === undefined
          ? Stream.empty
          : SubscriptionRef.changes(installed),
      watch: () => Stream.empty,
      read: () => Effect.sync(current),
    },
  }));
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
      'stops the resumed run for a Ctrl-C issued while its run is still rehydrating',
      () =>
        Effect.gen(function* () {
          // The early launch claim makes this resume() interruptible as soon
          // as the session accepts the run: a Ctrl-C in that window lands on
          // the resumed run, which ends cancelled, rather than leaving it
          // running.
          const rehydrated = Promise.withResolvers<void>();
          const session = new TuiSession();
          const stops: RunId[] = [];
          mocks.request.mockImplementation((req: RuntimeCommand) =>
            Effect.sync((): Outcome => {
              if (req.kind === 'run.stop') stops.push(req.runId);
              return { kind: 'done' };
            }),
          );
          mocks.resumeRun.mockImplementationOnce((id: RunId) => {
            const run = resumedRun(id, () => RUN_OUTCOME.CANCELLED);
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

          // A stop lands only on a run the session holds.
          seedView(viewWith([{ id: decodeRunId('aaaaaa') }]));
          // The resume command, run the way the Ink handler runs it.
          const resumed = yield* Effect.forkChild(
            ctrl.resume(decodeRunId('aaaaaa')),
            { startImmediately: true },
          );
          // resume() has claimed the launch synchronously; once the durable
          // record resolves the session holds the resumed run, the chat's
          // root.
          expect(session.launched).toBeDefined();
          yield* Fiber.join(resumed);
          expect(rootRunId.get()).toBe('aaaaaa');
          // #8273 regression: the stop facts are a signal, so status
          // rendering derives the Ctrl-C hint from it instead of calling
          // impure session closures that memoized renders cache stale.
          expect(canStopRootRun.get()).toBe(true);

          // Ctrl-C fires while the resumed run is still rehydrating.
          ctrl.stop('user');
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(stops).toEqual(['aaaaaa'])),
          );
          rehydrated.resolve();

          // The stop ends the run cancelled; the chat exits as interrupted.
          seedView(endedView(decodeRunId('aaaaaa'), RUN_OUTCOME.CANCELLED));
          expect(session.exitCode).toBe(CliExitCode.Interrupted);
          expect(session.canStartRootRun()).toBe(true);
        }),
    );

    it.effect(
      'a run that fails while the chat is leaving exits as a failure',
      () =>
        Effect.gen(function* () {
          // The quit does not make a failure a success: a run whose end was
          // lost exits as a failure, whether or not the chat is leaving.
          const session = new TuiSession();
          const failing = Promise.withResolvers<void>();
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
          seedView(viewWith([{ id: decodeRunId('aaaaaa') }]));
          yield* ctrl.resume(decodeRunId('aaaaaa'));
          expect(rootRunId.get()).toBe('aaaaaa');
          // The user quits while the run still works; its failure lands after.
          session.exited = Promise.resolve(CliExitCode.Success);
          failing.resolve();
          seedView(endedView(decodeRunId('aaaaaa'), null));

          expect(session.exitCode).toBe(CliExitCode.AgentError);
        }),
    );

    it.effect(
      'sends messages typed while a stop finishes to the session in order, and the next to the stopped run',
      () =>
        Effect.gen(function* () {
          // Typed while the stop finishes: both go to the session's own
          // acceptance for that run at once, in order; the session waits for
          // the stop and resumes the run. Once the stop has ended the run, a
          // later message still goes to it, so it cannot start a second root
          // beside it.
          seedView(viewWith([{ id: decodeRunId('a11111') }]));
          installSession(installableViewRef());
          rootRunId.set(decodeRunId('a11111'));
          const session = new TuiSession();
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
          expect(session.canStartRootRun()).toBe(false);

          seedView(endedView(decodeRunId('a11111'), RUN_OUTCOME.CANCELLED));
          yield* ctrl.submit({ ...EMPTY_DRAFT, text: 'Then this.' });
          expect(sent.at(-1)).toBe('a11111 Then this.');
          expect(mocks.executeAgent).not.toHaveBeenCalled();
          expect(rootRunId.get()).toBe('a11111');
        }),
    );

    it.effect(
      'holds the launch until the view shows its run, for a stop and a message',
      () =>
        Effect.gen(function* () {
          // A service window's view follows the run on its own watch, so the
          // session can acknowledge the launch before the view lists it.
          // Until it does, the launch is the chat's way to the run: Ctrl-C
          // can stop it, and a stop or a message asked then reaches it once
          // the view shows it, instead of being lost or starting a second
          // root.
          installSession(installableViewRef());
          const session = new TuiSession();
          const ctrl = createChatSessionController(
            yield* makeInit({
              session,
              served: true,
              // cast: these plain messages match no slash command, so only
              // the empty table is read.
              getSlashCommandContext: () =>
                ({ commands: slashCommands([]) }) as SlashCommandContext,
            }),
          );
          const sent: string[] = [];
          mocks.request.mockImplementation((req: RuntimeCommand) =>
            Effect.sync((): Outcome => {
              if (req.kind === 'followUp.send' || req.kind === 'run.stop')
                sent.push(`${req.kind} ${req.runId}`);
              return req.kind === 'followUp.send'
                ? {
                    kind: 'followUp',
                    id: 'sent-1',
                    status: 'sent',
                    receipt: { state: 'accepted' },
                  }
                : { kind: 'done' };
            }),
          );
          // The run works on: its result never comes in this test.
          mocks.executeAgent.mockReturnValue(new Promise(() => {}));

          const starting = yield* Effect.forkChild(
            ctrl.startRootRun({
              agent: 'demo-agent',
              model: 'demo-model',
              instruction: 'Start here.',
            }),
            { startImmediately: true },
          );
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(mocks.rootLaunch).toHaveBeenCalledOnce()),
          );
          const [{ runId: launched }] = mocks.rootLaunch.mock.calls[0];
          expect(canStopRootRun.get()).toBe(true);
          const messaging = yield* Effect.forkChild(
            ctrl.submit({ ...EMPTY_DRAFT, text: 'And then this.' }),
            { startImmediately: true },
          );
          ctrl.stop('user');

          seedView(viewWith([{ id: launched }]));
          yield* Fiber.join(starting);
          yield* Fiber.join(messaging);

          expect(mocks.rootLaunch).toHaveBeenCalledOnce();
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(sent.toSorted()).toEqual([
                `followUp.send ${launched}`,
                `run.stop ${launched}`,
              ]),
            ),
          );
        }),
    );

    it.effect("exits as a failure when the root's result cannot be read", () =>
      Effect.gen(function* () {
        // The run's result fails (its connection died) while the view,
        // no longer updated, still shows it running here.
        const session = new TuiSession();
        mocks.resumeRun.mockImplementationOnce((id: RunId) =>
          Effect.succeed({
            runId: id,
            result: Effect.fail(new Error('the service connection closed')),
          }),
        );
        const ctrl = createChatSessionController(yield* makeInit({ session }));
        seedView(viewWith([{ id: decodeRunId('aaaaaa') }]));
        yield* ctrl.resume(decodeRunId('aaaaaa'));
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(mocks.appendLocalErrorTranscript).toHaveBeenCalled(),
          ),
        );

        expect(session.exitCode).toBe(CliExitCode.AgentError);
      }),
    );

    it.effect(
      "keeps a resume's run as the root when an earlier message's reply resumes the old one",
      () =>
        Effect.gen(function* () {
          // A message to the stopped root is still on its way when the user
          // resumes another conversation. The reply that the session resumed
          // the old root lands while the resume is launching: the resume is
          // newer, so its run stays the chat's root.
          const old = decodeRunId('a11111');
          const picked = decodeRunId('b22222');
          seedView(viewWith([{ id: old }]));
          seedView(endedView(old, RUN_OUTCOME.CANCELLED));
          installSession(installableViewRef());
          rootRunId.set(old);
          const session = new TuiSession();
          const ctrl = createChatSessionController(
            yield* makeInit({
              session,
              served: true,
              // cast: this plain message matches no slash command, so only
              // the empty table is read.
              getSlashCommandContext: () =>
                ({ commands: slashCommands([]) }) as SlashCommandContext,
            }),
          );
          const reply = Promise.withResolvers<void>();
          mocks.request.mockImplementation((req: RuntimeCommand) =>
            req.kind === 'followUp.send'
              ? Effect.promise(async (): Promise<Outcome> => {
                  await reply.promise;
                  return {
                    kind: 'followUp',
                    id: 'sent-1',
                    status: 'queued',
                    receipt: { state: 'accepted' },
                  };
                })
              : Effect.succeed<Outcome>({ kind: 'done' }),
          );
          const resumed = Promise.withResolvers<void>();
          mocks.resumeRun.mockImplementationOnce((id: RunId) =>
            Effect.andThen(
              Effect.promise(() => resumed.promise),
              Effect.succeed(resumedRun(id)),
            ),
          );

          const sending = yield* Effect.forkChild(
            ctrl.submit({ ...EMPTY_DRAFT, text: 'Carry on.' }),
            { startImmediately: true },
          );
          const resuming = yield* Effect.forkChild(ctrl.resume(picked), {
            startImmediately: true,
          });
          expect(session.launched).toBeDefined();
          reply.resolve();
          yield* Fiber.join(sending);
          resumed.resolve();
          yield* Fiber.join(resuming);

          expect(rootRunId.get()).toBe(picked);
        }),
    );
  });
});
