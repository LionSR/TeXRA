import { layer } from '@effect/vitest';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream,
  Context,
} from 'effect';

import {
  RunFailure,
  type OutcomeOf,
  type Run,
  type LocalSession,
  type StartInput,
} from '@texra-ai/harness';
import {
  APPROVAL_BYPASS_KINDS,
  qualifyAggregateId,
  type RunId,
  type RuntimeRequest,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { liveToolGates } from '@agent/runtime/requestPolicy';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { humanGrant } from '@agent/runtime/runApprovalQueue';
import type { CliContext } from '@cli/runtime/cliContext';
import type { executeCliConfig } from '@cli/runtime/executeCli';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import { SessionLog } from '@shared/session/runHistory';
import { createTestCliContext as cliContext } from '@test/cli/fixtures/cliContext';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { publishTestRows, seedRows } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  emit: vi.fn(),
  attachRunProgressRenderer: vi.fn(),
  detachSessionProgressProjection: vi.fn(),
  attachScriptPlainOutput: vi.fn(),
  createHeadlessCliHostInteractions: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  rootLaunch: vi.fn(),
  admit: vi.fn(),
  stopRequest: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStderrAndWait: vi.fn<() => Effect.Effect<void>>(() => Effect.void),
}));

/** Lets the forked run fiber and the process-runtime shutdown handler cross a macrotask. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

const tempDirs = useTempDirs();

/** Each test's host, in a temp directory of its own, and the session over
 *  its roots, on the project's store. */
const perTest = Layer.provideMerge(
  TestSession.layer(undefined, { persistent: true, host: {} }),
  FakeHost.layer(() => createTempDirPlatform('texra-run-', tempDirs)),
);

/** What the session's start receives: the request under the id the CLI
 *  minted, and the approval and parking it asks for. */
type LaunchInput = Extract<StartInput, { readonly config: unknown }> & {
  readonly runId: RunId;
};

/**
 * The process session as every host drives it: it admits a start once
 * `admit` settles and the run's result is the suite's `rootLaunch`; its
 * stops are recorded in the mock bag (`stopRequest` may answer one).
 */
function runSessionFake(session: LocalSession): LocalSession {
  return {
    ...session,
    start: (input) =>
      // A rejected admission is a defect, as an unexpected launch failure is.
      Effect.promise(() => mocks.admit(input)).pipe(
        Effect.map((): Run => ({
          runId: input.runId as RunId,
          result: Effect.tryPromise({
            try: () =>
              mocks.rootLaunch(input) as Promise<Effect.Success<Run['result']>>,
            catch: (cause) =>
              new RunFailure({ cause, message: toErrorMessage(cause) }),
          }),
          view: Stream.empty,
          events: Stream.empty,
          interrupt: Effect.void,
        })),
      ),
    // cast: a stop answers `done`, as every other kind is answered by the
    // real session.
    request: ((req: RuntimeRequest) =>
      req.kind === 'run.stop'
        ? Effect.suspend(
            (): Effect.Effect<OutcomeOf<'run.stop'>, never> =>
              mocks.stopRequest(req) ?? Effect.succeed({ kind: 'done' }),
          )
        : session.request(req)) as LocalSession['request'],
  };
}

vi.mock('@cli/runtime/cliPresentationHost', () => ({
  createCliRuntimeHost: mocks.createCliRuntimeHost,
}));

vi.mock('@cli/runtime/approvalAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/approvalAdapter')>()),
  createHeadlessCliHostInteractions: mocks.createHeadlessCliHostInteractions,
}));

vi.mock('@cli/runtime/sessionProgressSubscription', () => ({
  attachCliSessionProgressProjection: vi.fn(() =>
    Effect.succeed(Effect.suspend(mocks.detachSessionProgressProjection)),
  ),
}));

vi.mock('@cli/runtime/scriptPlainOutput', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/scriptPlainOutput')>()),
  attachScriptPlainOutput: mocks.attachScriptPlainOutput,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
  writeTextStderrAndWait: mocks.writeTextStderrAndWait,
}));

/** Result shape the default `rootLaunch` stub resolves with. */
const COMPLETED_RUN = {
  outcome: 'completed',
  output: { response: '', files: [] },
  runId: 'ec0000000001',
} as const;

/** The end a run the shutdown stopped stores. */
const STOPPED = { ...COMPLETED_RUN, outcome: 'cancelled' } as const;

function baseConfig(): Parameters<typeof executeCliConfig>[0] {
  return { agent: 'chat', model: 'test-model', instruction: '' };
}

/** The id the run under test was launched with: the CLI mints it. */
function launchedRunId(): RunId {
  return (mocks.admit.mock.calls[0]?.[0] as LaunchInput).runId;
}

/** A run program's options with the session, runtime and shutdown scope
 *  the wrapper below supplies. */
type WithoutSession<O> = Omit<O, 'services'>;

/**
 * The command under test. The commands thread `initCliPlatform`'s session,
 * runtime and shutdown scope in; here the test's session stands in for the
 * first, the block's graph for the second and the test host's shutdown
 * scope for the third.
 */
const loadExecuteCli = Effect.gen(function* () {
  const runtime = yield* Effect.promise(
    () => import('@cli/runtime/executeCli'),
  );
  const session = yield* TestSession;
  const services = {
    session: Effect.sync(() => runSessionFake(session)),
    runtime: yield* SessionGraph.runtime,
    shutdownScope: (yield* FakeHost).platform.shutdownScope,
  };
  return {
    executeCliConfig: (
      config: Parameters<typeof runtime.executeCliConfig>[0],
      context: Parameters<typeof runtime.executeCliConfig>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliConfig>[2]
      > = {},
    ) => runtime.executeCliConfig(config, context, { services, ...options }),
  };
});

/** The opening a run's loop commits: its `run.start` row. */
const runStartRow = (runId: RunId) => ({
  type: 'run.start' as const,
  aggregateId: qualifyAggregateId('run', runId),
  identity: { kind: 'agent' as const, agent: 'chat' },
  userFollowUpSupport: 'unsupported' as const,
  parent: null,
  provenance: null,
});

/**
 * Stubs the run to publish its admission through `published` and then hang
 * until the test resolves it: the shape the shutdown tests drive. Its stop
 * reaches the session as a `run.stop` request (`stopRequest`). The run's
 * loop has opened it (its `run.start` row), so it can be resumed from its
 * rows.
 */
function stubHangingRun(
  session: Context.Context<SessionServices>,
  published: Deferred.Deferred<void>,
): {
  resolve: (result: unknown) => void;
} {
  let resolveRun!: (result: unknown) => void;
  mocks.rootLaunch.mockImplementation((input: LaunchInput) => {
    // Committed before the run reports admission, so every later read
    // of its rows finds the opening.
    const opening = Effect.runPromise(
      seedRows(Context.get(session, SessionLog))([runStartRow(input.runId)]),
    );
    return new Promise((resolve) => {
      resolveRun = resolve;
      void opening.then(() => Deferred.doneUnsafe(published, Effect.void));
    });
  });
  return { resolve: (result: unknown) => resolveRun(result) };
}

function stubExecuteCliDeps(): void {
  vi.clearAllMocks();
  mocks.close.mockReturnValue(Effect.void);
  // The projection's detach is an Effect the run drains, not a promise.
  mocks.detachSessionProgressProjection.mockReturnValue(Effect.void);
  mocks.attachRunProgressRenderer.mockReturnValue(Effect.void);
  mocks.attachScriptPlainOutput.mockReturnValue(Effect.void);
  // The host answers the session's approval question the way the headless
  // adapter does: whether this context can answer a prompt.
  mocks.createHeadlessCliHostInteractions.mockImplementation(
    (_session: unknown, context: CliContext) =>
      Effect.succeed({
        emit: mocks.emit,
        pending: vi.fn(() => []),
        resolve: vi.fn(() => false),
        cancel: vi.fn(),
        approvalPromptsUnavailable: context.mode !== 'interactive',
      }),
  );
  mocks.createCliRuntimeHost.mockReturnValue({
    emit: mocks.emit,
    attachRunProgressRenderer: mocks.attachRunProgressRenderer,
    prepareInteractivePrompt: mocks.prepareInteractivePrompt,
    close: mocks.close,
  });
  mocks.rootLaunch.mockResolvedValue(COMPLETED_RUN);
  mocks.admit.mockResolvedValue(undefined);
  mocks.stopRequest.mockReturnValue(undefined);
}

// Live clock: the run is forked in-fiber, but the command's shutdown step
// settles on the process runtime, and the session's publisher runs on real
// turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'executeCliConfig',
  (it) => {
    it.layer(perTest, { buildPerTest: true })((it) => {
      beforeEach(() => {
        stubExecuteCliDeps();
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      /** Whether the session withheld approval-gated tools while the run
       *  launched: its policy and the grants its `run.start` records, as the
       *  root launch records them, applied to what the attached host can
       *  answer. */
      const promptsUnavailableAtLaunch = (
        session: Context.Context<SessionServices>,
      ): (() => boolean | undefined) => {
        let seen: boolean | undefined;
        mocks.rootLaunch.mockImplementationOnce(
          async (request: LaunchInput) => {
            if (request.approval?.delegated) {
              publishTestRows(session, [
                {
                  ...runStartRow(request.runId),
                  approvalPolicy: humanGrant(
                    APPROVAL_BYPASS_KINDS,
                    true,
                  )(NO_APPROVAL_GRANTS),
                },
              ]);
              await Effect.runPromise(Context.get(session, SessionLog).settled);
            }
            seen = (
              await Effect.runPromise(
                liveToolGates({
                  runId: request.runId,
                  entry: { registration: null },
                }).pipe(Effect.provide(session)),
              )
            ).approvalPromptsUnavailable;
            return COMPLETED_RUN;
          },
        );
        return () => seen;
      };

      it.effect.each([
        { policy: 'never', overrides: {} },
        { policy: 'ask', overrides: { approvalPolicy: 'ask' } },
      ] as const)(
        'marks headless $policy runs as approval-unavailable for agent run',
        ({ overrides }) =>
          Effect.gen(function* () {
            const { executeCliConfig } = yield* loadExecuteCli;
            const seen = promptsUnavailableAtLaunch(
              yield* Effect.flatMap(TestSession, sessionHandleOf),
            );

            yield* executeCliConfig(baseConfig(), cliContext(overrides));

            expect(seen()).toBe(true);
          }),
      );

      it.effect('marks owned runs interrupted during platform shutdown', () =>
        Effect.gen(function* () {
          const { platform } = yield* FakeHost;
          const { executeCliConfig } = yield* loadExecuteCli;
          let settleRecoveryWrite!: () => void;
          const recoveryWrite = new Promise<void>((resolve) => {
            settleRecoveryWrite = resolve;
          });
          const finalized = yield* Deferred.make<void>();
          const onInterruptedRunFinalized = vi.fn(() => {
            Deferred.doneUnsafe(finalized, Effect.void);
            return Effect.promise(() => recoveryWrite);
          });
          const published = yield* Deferred.make<void>();
          const hangingRun = stubHangingRun(
            yield* Effect.flatMap(TestSession, sessionHandleOf),
            published,
          );

          const run = yield* Effect.forkChild(
            executeCliConfig(baseConfig(), cliContext(), {
              onInterruptedRunFinalized,
            }),
          );
          yield* Deferred.await(published);
          // The stub resumes this fiber synchronously, so one macrotask lets the
          // rest of the stub (the tracked launch handle) run first.
          yield* settle;
          const shutdown = yield* Effect.forkChild(
            Scope.close(platform.shutdownScope, Exit.void),
            { startImmediately: true },
          );
          yield* settle;
          expect(mocks.stopRequest).toHaveBeenCalledExactlyOnceWith({
            kind: 'run.stop',
            runId: launchedRunId(),
            detachActiveChildren: false,
            reason: 'shutdown',
          });

          hangingRun.resolve(STOPPED);
          yield* Deferred.await(finalized);
          yield* settle;
          let shutdownResolved = false;
          shutdown.addObserver(() => {
            shutdownResolved = true;
          });
          yield* settle;
          expect(shutdownResolved).toBe(false);
          settleRecoveryWrite();
          yield* Fiber.join(shutdown);
          expect(onInterruptedRunFinalized).toHaveBeenCalledExactlyOnceWith(
            launchedRunId(),
          );
          // The stored cancelled end is the run's result: the record every
          // caller emits, whose outcome exits as the interruption (130).
          expect(yield* Fiber.join(run)).toMatchObject({
            ok: true,
            result: { outcome: 'cancelled', runId: launchedRunId() },
          });
        }),
      );
    });
  },
);
