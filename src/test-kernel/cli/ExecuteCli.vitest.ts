import '@test/support/sessionGraphTestSetup';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from 'effect';

import {
  RunFailure,
  type Outcome,
  type Run,
  type LocalSession,
  type StartInput,
} from '@texra-ai/harness';
import { liveToolGates } from '@agent/runtime/requestPolicy';
import { humanGrant } from '@agent/runtime/runApprovalQueue';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { executeCliRequest } from '@cli/runtime/executeCli';
import { AgentError } from '@common/errors/agentErrors';
import {
  APPROVAL_BYPASS_KINDS,
  NO_APPROVAL_GRANTS,
} from '@shared/approvalBypassKind';
import { qualifyAggregateId, RUN_OUTCOME } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import {
  fakeProcessServices,
  installFakeHost,
  installedHost,
} from '@test/support/setupPlatform';
import { createTestCliContext as cliContext } from '@test/cli/fixtures/cliContext';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRows, seedRows } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { RuntimeRequest } from '@texra-ai/harness/schemas';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  settled: vi.fn(),
  emit: vi.fn(),
  attachRunProgressRenderer: vi.fn(),
  detachSessionProgressProjection: vi.fn(),
  attachScriptPlainOutput: vi.fn(),
  createHeadlessCliHostInteractions: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliRunOutcomeState: vi.fn(),
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

async function installFreshDefaultSession(): Promise<void> {
  await installStoragePlatform();
  await import('@test/support/sessionGraphTestSetup');
  const { openTestDefaultSession, closeTestDefaultSession } =
    await import('@test/support/sessionEnd');
  await Effect.runPromise(closeTestDefaultSession);
  await Effect.runPromise(
    openTestDefaultSession({ roots: testWorkspaceRoots() }),
  );
}

async function installStoragePlatform(): Promise<void> {
  await installFakeHost(await createTempDirPlatform('texra-run-', tempDirs));
}

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
function runSessionFake(): LocalSession {
  const session = testSessionOf(testDefaultSession());
  return {
    ...session,
    settled: Effect.suspend(() => mocks.settled() ?? session.settled),
    start: (input) =>
      // A rejected admission is a defect, as an unexpected launch failure is.
      Effect.promise(() => mocks.admit(input)).pipe(
        Effect.map((): Run => ({
          runId: input.runId as RunId,
          // A stopped run commits its CANCELLED end and re-raises the stop.
          result: Effect.tryPromise({
            try: () => mocks.rootLaunch(input),
            catch: (cause) =>
              new RunFailure({ cause, message: toErrorMessage(cause) }),
          }).pipe(
            Effect.flatMap((ended): Run['result'] =>
              ended === STOPPED
                ? Effect.interrupt
                : Effect.succeed(ended as Effect.Success<Run['result']>),
            ),
          ),
          view: Stream.empty,
          events: Stream.empty,
          interrupt: Effect.void,
        })),
      ),
    request: (req: RuntimeRequest) =>
      req.kind === 'run.stop'
        ? Effect.suspend(
            (): Effect.Effect<Outcome, never> =>
              mocks.stopRequest(req) ?? Effect.succeed({ kind: 'done' }),
          )
        : session.request(req),
  };
}

vi.mock('@cli/runtime/cliPresentationHost', () => ({
  createCliRuntimeHost: mocks.createCliRuntimeHost,
}));

vi.mock('@cli/runtime/approvalAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/approvalAdapter')>()),
  createHeadlessCliHostInteractions: mocks.createHeadlessCliHostInteractions,
}));

vi.mock('@cli/runtime/terminalStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/terminalStatus')>()),
  readCliRunOutcomeState: (...args: unknown[]) =>
    Effect.tryPromise(() => mocks.readCliRunOutcomeState(...args)),
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

type CliRequest = Parameters<typeof executeCliRequest>[0];

/** Result shape the default `rootLaunch` stub resolves with. */
const COMPLETED_RUN = {
  outcome: 'completed',
  output: { response: '', files: [] },
  runId: 'ec0000000001',
} as const;

/** What a run the shutdown stopped ends with. */
const CANCELLED_RUN = { ...COMPLETED_RUN, outcome: 'cancelled' } as const;

/** A run the shutdown stopped whose result re-raises the stop, as
 *  `AgentRunLifecycle` does once its CANCELLED end is committed. */
const STOPPED = Symbol('stopped');

function baseRequest(): CliRequest {
  return { config: {}, runId: 'ec0000000001' } as unknown as CliRequest;
}

function toolUseConfig() {
  return {
    agent: 'chat',
    model: 'openai/gpt-5.4-2026-03-05',
    inputFiles: [] as string[],
    contextFiles: [] as string[],
    instruction: 'Check this.',
    workingDirectory: '/tmp/project',
  };
}

/** A run program's options with the session, runtime and shutdown scope
 *  the wrapper below supplies. */
type WithoutSession<O> = Omit<O, 'services'>;

/** The run's services over the default test session. */
const testServices = () => ({
  session: Effect.sync(runSessionFake),
  runtime: testRuntime(),
  shutdownScope: installedHost().platform.shutdownScope,
});

async function loadExecuteCli() {
  const runtime = await import('@cli/runtime/executeCli');
  // The commands thread `initCliPlatform`'s session, runtime and shutdown
  // scope in; here the process default this file installs stands in for the
  // first two and the installed host's shutdown scope for the third.
  return {
    ...runtime,
    executeCliRequest: (
      request: Parameters<typeof runtime.executeCliRequest>[0],
      context: Parameters<typeof runtime.executeCliRequest>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliRequest>[2]
      > = {},
    ) =>
      Effect.provide(
        runtime.executeCliRequest(request, context, {
          services: testServices(),
          ...options,
        }),
        fakeProcessServices(),
      ),
    executeCliConfig: (
      config: Parameters<typeof runtime.executeCliConfig>[0],
      context: Parameters<typeof runtime.executeCliConfig>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliConfig>[2]
      > = {},
    ) =>
      Effect.provide(
        runtime.executeCliConfig(config, context, {
          services: testServices(),
          ...options,
        }),
        fakeProcessServices(),
      ),
    executeCliToolUseConfig: (
      config: Parameters<typeof runtime.executeCliToolUseConfig>[0],
      context: Parameters<typeof runtime.executeCliToolUseConfig>[1],
      options: WithoutSession<
        Parameters<typeof runtime.executeCliToolUseConfig>[2]
      > = {},
    ) =>
      Effect.provide(
        runtime.executeCliToolUseConfig(config, context, {
          services: testServices(),
          ...options,
        }),
        fakeProcessServices(),
      ),
  };
}

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
 * reaches the session as a `run.stop` request (`stopRequest`). Unless
 * `opened` is false, the run's loop has opened it (its `run.start` row), so
 * it can be resumed from its rows.
 */
function stubHangingRun(
  published: Deferred.Deferred<void>,
  { opened = true } = {},
): {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
} {
  let resolveRun!: (result: unknown) => void;
  let rejectRun!: (error: unknown) => void;
  mocks.rootLaunch.mockImplementation((input: LaunchInput) => {
    // Committed before the run reports admission, so every later read
    // of its rows finds the opening.
    const opening = opened
      ? testRuntime().runPromise(
          seedRows(testDefaultSession().log)([runStartRow(input.runId)]),
        )
      : Promise.resolve();
    return new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
      void opening.then(() => Deferred.doneUnsafe(published, Effect.void));
    });
  });
  return {
    resolve: (result: unknown) => resolveRun(result),
    reject: (error: unknown) => rejectRun(error),
  };
}

async function stubExecuteCliDeps(): Promise<void> {
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
  mocks.readCliRunOutcomeState.mockResolvedValue({
    outcome: 'completed',
    outcomePersisted: true,
  });
  mocks.rootLaunch.mockResolvedValue(COMPLETED_RUN);
  mocks.admit.mockResolvedValue(undefined);
  mocks.stopRequest.mockReturnValue(undefined);
}

/** Queues one cancelled, persisted outcome read for the next resolution. */
function mockCancelledOutcome(): void {
  mocks.readCliRunOutcomeState.mockResolvedValueOnce({
    outcome: RUN_OUTCOME.CANCELLED,
    outcomePersisted: true,
  });
}

/** Loads shutdown tests against the host that owns the current session. */
async function loadExecuteCliOnInstalledHost() {
  const host = installedHost();
  const { executeCliRequest } = await loadExecuteCli();
  return { platform: host.platform, executeCliRequest };
}

describe('executeCliRequest', () => {
  beforeEach(async () => {
    await stubExecuteCliDeps();
    await installFreshDefaultSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect.each(['text', 'json'] as const)(
    'does not attach the CLI progress projection for %s output',
    (outputFormat) =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const { attachCliSessionProgressProjection } = yield* Effect.promise(
          () => import('@cli/runtime/sessionProgressSubscription'),
        );
        const attachProjection = vi.mocked(attachCliSessionProgressProjection);
        const request = baseRequest();

        yield* executeCliRequest(request, cliContext({ outputFormat }));

        expect(attachProjection).not.toHaveBeenCalled();
        expect(mocks.detachSessionProgressProjection).not.toHaveBeenCalled();
      }),
  );

  /** Whether the session withheld approval-gated tools while the run
   *  launched: its policy and the grants its `run.start` records, as the
   *  root launch records them, applied to what the attached host can
   *  answer. */
  const promptsUnavailableAtLaunch = (): (() => boolean | undefined) => {
    let seen: boolean | undefined;
    mocks.rootLaunch.mockImplementationOnce(async (request: LaunchInput) => {
      const session = testDefaultSession();
      if (request.approval?.delegated) {
        publishTestRows(session, [
          {
            type: 'run.start',
            aggregateId: qualifyAggregateId('run', request.runId),
            identity: { kind: 'agent', agent: 'chat' },
            userFollowUpSupport: 'unsupported',
            parent: null,
            provenance: null,
            approvalPolicy: humanGrant(
              APPROVAL_BYPASS_KINDS,
              true,
            )(NO_APPROVAL_GRANTS),
          },
        ]);
        await testRuntime().runPromise(session.log.settled);
      }
      seen = liveToolGates({
        session,
        runId: request.runId,
        entry: { registration: null },
      }).approvalPromptsUnavailable;
      return COMPLETED_RUN;
    });
    return () => seen;
  };

  it.effect.each([
    { policy: 'never', overrides: {} },
    { policy: 'ask', overrides: { approvalPolicy: 'ask' } },
  ] as const)(
    'marks headless $policy runs as approval-unavailable for agent run',
    ({ overrides }) =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const seen = promptsUnavailableAtLaunch();

        yield* executeCliRequest(baseRequest(), cliContext(overrides));

        expect(seen()).toBe(true);
      }),
  );

  it.effect('presents a classified run failure as its exit code', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();
      mocks.rootLaunch.mockRejectedValueOnce(
        new AgentError({ message: 'boom' }),
      );
      const order: string[] = [];
      mocks.settled.mockImplementationOnce(() =>
        Effect.sync(() => order.push('settled')),
      );
      mocks.close.mockImplementationOnce(() =>
        Effect.sync(() => order.push('detached')),
      );

      // #7645: a classified run failure resolves to a non-zero exit code
      // instead of rethrowing — otherwise it reaches bin/texra.ts's crash
      // handler and gets misreported as an unexpected crash (double-printed
      // message + a false "please report it" line).
      const result = yield* executeCliRequest(request, cliContext());

      expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
      expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'boom',
      });
      // A failed run's end reaches its presenter through the fold: the
      // presentation host detaches only once the session settled.
      expect(order).toEqual(['settled', 'detached']);
    }),
  );

  // it.live for the shutdown choreography below: the run is forked in-fiber,
  // but the command's shutdown step settles on the process runtime.
  it.live('marks owned runs interrupted during platform shutdown', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
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
      const hangingRun = stubHangingRun(published);

      const run = yield* Effect.forkChild(
        executeCliRequest(baseRequest(), cliContext(), {
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
        runId: 'ec0000000001',
        detachActiveChildren: false,
        reason: 'shutdown',
      });

      mockCancelledOutcome();
      hangingRun.resolve(STOPPED);
      yield* Deferred.await(finalized);
      yield* settle;
      expect(onInterruptedRunFinalized).toHaveBeenCalledOnce();
      let shutdownResolved = false;
      shutdown.addObserver(() => {
        shutdownResolved = true;
      });
      yield* settle;
      expect(shutdownResolved).toBe(false);
      settleRecoveryWrite();
      yield* Fiber.join(shutdown);
      expect(onInterruptedRunFinalized).toHaveBeenCalledExactlyOnceWith(
        'ec0000000001',
      );
      expect(yield* Fiber.join(run)).toEqual({
        ok: false,
        exitCode: CliExitCode.Interrupted,
      });
    }),
  );

  it.live(
    'cancels launch preparation when shutdown precedes run registration',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const launch = yield* Deferred.make<void>();
        // The session has not admitted the run when the shutdown comes: the
        // launch is interrupted, which aborts it.
        mocks.admit.mockImplementationOnce(
          () =>
            new Promise<never>(() => {
              Deferred.doneUnsafe(launch, Effect.void);
            }),
        );

        const run = yield* Effect.forkChild(
          executeCliRequest(
            { ...baseRequest(), runId: generateRunId() },
            cliContext(),
            {},
          ),
        );
        yield* Deferred.await(launch);
        yield* settle;

        yield* Scope.close(platform.shutdownScope, Exit.void);
        expect(yield* Fiber.join(run)).toEqual({
          ok: false,
          exitCode: CliExitCode.Interrupted,
        });
      }),
  );

  it.live(
    'preserves a terminal outcome when shutdown cannot interrupt the finished run',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        // The run has ended: the session refuses its stop.
        mocks.stopRequest.mockReturnValue(
          Effect.fail(new Error('The task is no longer open.')),
        );
        const published = yield* Deferred.make<void>();
        const hangingRun = stubHangingRun(published);
        const onInterruptedRunFinalized = vi.fn(() => Effect.void);
        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {
            onInterruptedRunFinalized,
          }),
        );
        yield* Deferred.await(published);
        yield* settle;

        const shutdown = yield* Effect.forkChild(
          Scope.close(platform.shutdownScope, Exit.void),
          { startImmediately: true },
        );
        hangingRun.resolve(COMPLETED_RUN);
        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);

        // A stop that reached no live run never reads the launch as
        // interrupted, so its rows promise no recovery.
        expect(onInterruptedRunFinalized).not.toHaveBeenCalled();
      }),
  );
});

describe('executeCliConfig', () => {
  beforeEach(async () => {
    await stubExecuteCliDeps();
    await installFreshDefaultSession();
  });

  // it.live for the two shutdown tests below: the run is forked in-fiber, but
  // the command's shutdown step settles on the process runtime.
  it.live(
    'prints a complete resume command after interrupted tool-use recovery is available',
    () =>
      Effect.gen(function* () {
        const { platform } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const { executeCliToolUseConfig } =
          yield* Effect.promise(loadExecuteCli);
        const context = cliContext({
          approvalPolicy: 'yolo',
          outputFormat: 'ndjson',
          skillSourceOptions: {
            includeInterop: true,
            additionalPaths: ['/tmp/skill path'],
          },
        });
        const published = yield* Deferred.make<void>();
        const hangingRun = stubHangingRun(published);
        const recoveryWrite = yield* Deferred.make<void>();
        const noticeStarted = yield* Deferred.make<void>();
        mocks.writeTextStderrAndWait.mockImplementationOnce(() => {
          Deferred.doneUnsafe(noticeStarted, Effect.void);
          return Deferred.await(recoveryWrite);
        });

        const run = yield* Effect.forkChild(
          executeCliToolUseConfig(toolUseConfig(), context, {
            stopAfterCycle: true,
          }),
        );
        yield* Deferred.await(published);
        yield* settle;
        const shutdown = yield* Effect.forkChild(
          Scope.close(platform.shutdownScope, Exit.void),
          { startImmediately: true },
        );
        mockCancelledOutcome();
        hangingRun.resolve(CANCELLED_RUN);

        yield* Deferred.await(noticeStarted);
        yield* settle;
        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledOnce();
        let shutdownResolved = false;
        shutdown.addObserver(() => {
          shutdownResolved = true;
        });
        yield* settle;
        expect(shutdownResolved).toBe(false);
        yield* Deferred.succeed(recoveryWrite, undefined);
        yield* Fiber.join(shutdown);
        expect(yield* Fiber.join(run)).toMatchObject({
          ok: true,
          exitCode: CliExitCode.Interrupted,
        });
        // The launch's own run id, minted for the tool-use request.
        const launched: { runId: RunId } = mocks.rootLaunch.mock.calls[0]?.[0];
        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledExactlyOnceWith(
          `Resume this task with: texra resume ${launched.runId} --cwd /tmp/project --approval-policy yolo --include-interop --source '/tmp/skill path'`,
        );
      }),
  );
});
