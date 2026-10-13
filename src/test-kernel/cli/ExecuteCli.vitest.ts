import '@test/support/sessionGraphTestSetup';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from 'effect';

import {
  RunFailure,
  type Outcome,
  type Run,
  type RuntimeRequest,
  type Session,
} from '@texra-ai/harness';
import { liveToolGates } from '@agent/runtime/requestPolicy';
import { humanGrant } from '@agent/runtime/runApprovalQueue';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { executeCliRequest } from '@cli/runtime/executeCli';
import { AgentError } from '@common/errors';
import { enablePlugin } from '@common/plugins/pluginTrust';
import {
  APPROVAL_BYPASS_KINDS,
  NO_APPROVAL_GRANTS,
} from '@shared/approvalBypassKind';
import { qualifyAggregateId, RUN_OUTCOME } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
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
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRows } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  emit: vi.fn(),
  attachRunProgressRenderer: vi.fn(),
  detachSessionProgressProjection: vi.fn(),
  attachScriptPlainOutput: vi.fn(),
  createHeadlessCliHostInteractions: vi.fn(),
  createCliRuntimeHost: vi.fn(),
  disposeHostInteractions: vi.fn(),
  prepareInteractivePrompt: vi.fn(),
  readCliRunOutcomeState: vi.fn(),
  deriveResumability: vi.fn(),
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

/** What the suite's launch stand-in receives: the request and the
 *  approval and parking it asks the session for. */
type LaunchInput = {
  readonly request: { readonly runId: RunId };
  readonly approval: {
    readonly approvalPolicy?: string;
    readonly approveDelegatedWork: boolean;
  };
};

/**
 * The agent boundary `executeCliRequest` runs through, injected through its
 * own options seam: the session admits the run once `admit` settles, its
 * result is the suite's `rootLaunch`, and the resumability read lands in
 * the mock bag.
 */
const agentRunsFake = {
  launch: (_session: Session, input: LaunchInput) =>
    Effect.tryPromise({
      try: () => mocks.admit(input),
      catch: (error) => error as Error,
    }).pipe(
      Effect.map((): Run => ({
        runId: input.request.runId as RunId,
        result: Effect.tryPromise({
          try: () => mocks.rootLaunch(input.request, input),
          catch: (cause) =>
            new RunFailure({ cause, message: toErrorMessage(cause) }),
        }),
        view: Stream.empty,
        events: Stream.empty,
        interrupt: Effect.void,
      })),
    ),
  resumability: (...args: unknown[]) =>
    Effect.promise(() => mocks.deriveResumability(...args)),
} as NonNullable<Parameters<typeof executeCliRequest>[2]['agentRuns']>;

/** The process session as every host drives it, its stops recorded in the
 *  mock bag (`stopRequest` may answer one). */
function runSessionFake(): Session {
  const session = testSessionOf(testDefaultSession(), { persistent: true });
  return {
    ...session,
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
  runId: 'exec-1',
} as const;

/** What a run the shutdown stopped ends with. */
const CANCELLED_RUN = { ...COMPLETED_RUN, outcome: 'cancelled' } as const;

function baseRequest(): CliRequest {
  return { config: {}, runId: 'exec-1' } as unknown as CliRequest;
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
type WithoutSession<O> = Omit<
  O,
  'session' | 'runSession' | 'runtime' | 'shutdownScope'
>;

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
          session: Effect.succeed(testDefaultSession()),
          runSession: Effect.sync(runSessionFake),
          runtime: testRuntime(),
          shutdownScope: installedHost().platform.shutdownScope,
          agentRuns: agentRunsFake,
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
          session: Effect.succeed(testDefaultSession()),
          runSession: Effect.sync(runSessionFake),
          runtime: testRuntime(),
          shutdownScope: installedHost().platform.shutdownScope,
          agentRuns: agentRunsFake,
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
          session: Effect.succeed(testDefaultSession()),
          runSession: Effect.sync(runSessionFake),
          runtime: testRuntime(),
          shutdownScope: installedHost().platform.shutdownScope,
          agentRuns: agentRunsFake,
          ...options,
        }),
        fakeProcessServices(),
      ),
  };
}

/**
 * Stubs the run to publish its admission through `published` and then hang
 * until the test resolves it: the shape the shutdown tests drive. Its stop
 * reaches the session as a `run.stop` request (`stopRequest`).
 */
function stubHangingRun(published: Deferred.Deferred<void>): {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
} {
  let resolveRun!: (result: unknown) => void;
  let rejectRun!: (error: unknown) => void;
  mocks.rootLaunch.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
        Deferred.doneUnsafe(published, Effect.void);
      }),
  );
  return {
    resolve: (result: unknown) => resolveRun(result),
    reject: (error: unknown) => rejectRun(error),
  };
}

/** Observe the session's terminal artifact drain. */
async function spyOnArtifactFlush() {
  // `settled` is a plain value on the log: make it an accessor to spy on.
  const { log } = testDefaultSession();
  const settled = log.settled;
  Object.defineProperty(log, 'settled', {
    configurable: true,
    get: () => settled,
  });
  const flushSpy = vi.spyOn(log, 'settled', 'get').mockReturnValue(Effect.void);
  return { flushSpy };
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
    (_session: unknown, _runtime: unknown, context: CliContext) => ({
      emit: mocks.emit,
      pending: vi.fn(() => []),
      resolve: vi.fn(() => false),
      cancel: vi.fn(),
      dispose: mocks.disposeHostInteractions,
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
  mocks.deriveResumability.mockResolvedValue({ kind: 'checkpoint' });
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

  it.effect(
    'attaches the CLI progress projection for NDJSON output before the run starts',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const { attachCliSessionProgressProjection } = yield* Effect.promise(
          () => import('@cli/runtime/sessionProgressSubscription'),
        );
        const attachProjection = vi.mocked(attachCliSessionProgressProjection);
        const request = baseRequest();

        yield* executeCliRequest(
          request,
          cliContext({ outputFormat: 'ndjson' }),
        );

        expect(attachProjection).toHaveBeenCalledTimes(1);
        // The writer slot: the projection defaults to the NDJSON stdout sink.
        expect(attachProjection.mock.calls[0]?.[1]).toBeUndefined();
        expect(mocks.rootLaunch).toHaveBeenCalledTimes(1);
        expect(attachProjection.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.rootLaunch.mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
        expect(mocks.detachSessionProgressProjection).toHaveBeenCalledTimes(1);
      }),
  );

  /** Whether the session withheld approval-gated tools while the run
   *  launched: its policy and the grants its `run.start` records, as the
   *  root launch records them, applied to what the attached host can
   *  answer. */
  const promptsUnavailableAtLaunch = (): (() => boolean | undefined) => {
    let seen: boolean | undefined;
    mocks.rootLaunch.mockImplementationOnce(
      async (request: { runId: RunId }, input: LaunchInput) => {
        const session = testDefaultSession();
        if (input.approval.approveDelegatedWork) {
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
        seen = liveToolGates(session, request.runId).approvalPromptsUnavailable;
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
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const seen = promptsUnavailableAtLaunch();

        yield* executeCliRequest(baseRequest(), cliContext(overrides));

        expect(seen()).toBe(true);
      }),
  );

  it.effect('keeps yolo runs approval-available for agent run', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const seen = promptsUnavailableAtLaunch();

      yield* executeCliRequest(
        { ...baseRequest(), runId: generateRunId() },
        cliContext({ approvalPolicy: 'yolo', requestedApprovalPolicy: 'yolo' }),
      );

      // An explicit yolo rides the launch as an Auto-approve launch; the
      // project's policy is never touched.
      expect(mocks.rootLaunch).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          approval: { approvalPolicy: 'yolo', approveDelegatedWork: true },
        }),
      );
      // The Auto-approve grant keeps its gated tools offered, headless.
      expect(seen()).toBe(false);
    }),
  );

  it.effect(
    'reports outcome read failures without rejecting a successful run',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const readError = new Error('metadata read failed');
        mocks.readCliRunOutcomeState.mockImplementationOnce(
          async (
            _session: unknown,
            result: { readonly outcome: string },
            reportReadFailure: (error: Error) => void,
          ) => {
            reportReadFailure(readError);
            return { outcome: result.outcome, outcomePersisted: false };
          },
        );

        expect(
          yield* executeCliRequest(baseRequest(), cliContext()),
        ).toMatchObject({
          ok: true,
          result: { outcome: 'completed' },
        });
        expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
          message: 'metadata read failed',
        });
      }),
  );

  it.effect('drains the session artifacts after the run', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();
      const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
      const callOrder: string[] = [];
      flushSpy.mockImplementation(() =>
        Effect.sync(() => {
          callOrder.push('flush');
        }),
      );
      mocks.rootLaunch.mockImplementationOnce(async () => {
        callOrder.push('rootLaunch');
        return {
          outcome: 'completed',
          output: { response: '', files: [] },
          runId: 'exec-1',
        };
      });

      yield* executeCliRequest(request, cliContext());

      expect(callOrder).toEqual(['rootLaunch', 'flush']);
    }),
  );

  it.effect('drains session artifacts even when the run throws', () =>
    Effect.gen(function* () {
      const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
      const request = baseRequest();
      const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
      mocks.rootLaunch.mockRejectedValueOnce(new AgentError('boom'));

      // #7645: a classified run failure resolves to a non-zero exit code
      // instead of rethrowing — otherwise it reaches bin/texra.ts's crash
      // handler and gets misreported as an unexpected crash (double-printed
      // message + a false "please report it" line).
      const result = yield* executeCliRequest(request, cliContext());

      expect(result).toEqual({ ok: false, exitCode: CliExitCode.AgentError });
      expect(mocks.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'boom',
      });
      expect(flushSpy).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'rethrows a non-AgentError rejection instead of swallowing it into an exit code',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        const request = baseRequest();
        const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
        // An unclassified failure (e.g. registerRun disk I/O,
        // workspaceState.update) is genuinely unexpected — it must keep
        // propagating so bin/texra.ts's crash handler reports it, instead of
        // being swallowed into a bare non-zero exit with no stderr. The defect
        // enters through the injected launch stand-in.
        const defectLaunch: typeof agentRunsFake = {
          ...agentRunsFake,
          launch: () => Effect.die(new Error('disk full')),
        };

        const error = yield* Effect.flip(
          executeCliRequest(request, cliContext(), { agentRuns: defectLaunch }),
        );
        expect(error.message).toContain('disk full');

        // Cleanup still runs via `finally` even though the error propagates.
        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(mocks.close).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'does not repeat an error already presented before lifecycle startup',
    () =>
      Effect.gen(function* () {
        const { executeCliRequest } = yield* Effect.promise(loadExecuteCli);
        mocks.rootLaunch.mockImplementationOnce(async () => {
          const hooks =
            mocks.createHeadlessCliHostInteractions.mock.calls[0]?.[3];
          hooks.emit('requestShowError', { message: 'Agent not found.' });
          throw new AgentError('Agent not found.');
        });

        expect(yield* executeCliRequest(baseRequest(), cliContext())).toEqual({
          ok: false,
          exitCode: CliExitCode.AgentError,
        });

        expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('requestShowError', {
          message: 'Agent not found.',
        });
      }),
  );

  // it.live for the shutdown choreography below: the run is forked in-fiber,
  // but the command's shutdown step settles on the process runtime.
  it.live('marks owned runs interrupted during platform shutdown', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
      const { flushSpy } = yield* Effect.promise(spyOnArtifactFlush);
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
        runId: 'exec-1',
        detachActiveChildren: false,
        reason: 'shutdown',
      });

      mockCancelledOutcome();
      hangingRun.resolve(CANCELLED_RUN);
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
      expect(flushSpy).toHaveBeenCalled();
      expect(onInterruptedRunFinalized).toHaveBeenCalledExactlyOnceWith(
        'exec-1',
      );
      expect(yield* Fiber.join(run)).toEqual({
        ok: true,
        outcomePersisted: true,
        result: {
          outcome: 'cancelled',
          output: { response: '', files: [] },
          runId: 'exec-1',
        },
      });
    }),
  );

  it.live(
    'does not advertise signal recovery before a flow checkpoint exists',
    () =>
      Effect.gen(function* () {
        const { platform, executeCliRequest } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        // Both reads (the shutdown's inspection, the drain's) find none.
        mocks.deriveResumability.mockResolvedValue({
          kind: 'none',
          outcome: RUN_OUTCOME.CANCELLED,
        });
        const onInterruptedRunFinalized = vi.fn();
        const published = yield* Deferred.make<void>();
        const hangingRun = stubHangingRun(published);

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
        mockCancelledOutcome();
        hangingRun.resolve(CANCELLED_RUN);

        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);

        expect(mocks.deriveResumability).toHaveBeenCalledWith(
          'exec-1',
          expect.anything(),
        );
        expect(onInterruptedRunFinalized).not.toHaveBeenCalled();
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
          executeCliRequest(baseRequest(), cliContext(), {}),
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
        const run = yield* Effect.forkChild(
          executeCliRequest(baseRequest(), cliContext(), {}),
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
        // interrupted, so nothing inspects it for recovery.
        expect(mocks.deriveResumability).not.toHaveBeenCalled();
      }),
  );

  it.live('removes the shutdown status hook after owned runs finish', () =>
    Effect.gen(function* () {
      const { platform, executeCliRequest } = yield* Effect.promise(
        loadExecuteCliOnInstalledHost,
      );
      const request = baseRequest();

      yield* executeCliRequest(request, cliContext(), {});
      yield* Scope.close(platform.shutdownScope, Exit.void);

      expect(mocks.deriveResumability).not.toHaveBeenCalled();
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

  it.live(
    'does not advertise recovery for invocation-owned temporary inputs',
    () =>
      Effect.gen(function* () {
        const { platform } = yield* Effect.promise(
          loadExecuteCliOnInstalledHost,
        );
        const { executeCliToolUseConfig } =
          yield* Effect.promise(loadExecuteCli);
        const published = yield* Deferred.make<void>();
        const hangingRun = stubHangingRun(published);

        const run = yield* Effect.forkChild(
          executeCliToolUseConfig(toolUseConfig(), cliContext(), {
            recoveryInputIsDurable: false,
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

        yield* Fiber.join(shutdown);
        yield* Fiber.join(run);
        expect(mocks.writeTextStderrAndWait).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'records each installed plugin that loads by source and pinned commit in the CLI result',
    () =>
      Effect.gen(function* () {
        const commit = 'a'.repeat(40);
        const pluginDir = yield* Effect.promise(() =>
          makeTempDir('texra-cli-plugin-', tempDirs),
        );
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(pluginDir, '.claude-plugin'));
          await fs.writeFile(
            path.join(pluginDir, '.claude-plugin', 'plugin.json'),
            JSON.stringify({ name: 'notes', version: '1.0.0' }),
          );
        });
        const plugin = {
          source: 'https://github.com/example/notes.git',
          commit,
          path: pluginDir,
          skills: [],
        };
        const { globalState } = testDefaultSession().roots;
        yield* globalState.update(GlobalStateKey.INSTALLED_PLUGINS, [
          { name: 'notes', ...plugin, enabled: false },
          // Enabled but never trusted: it loads nothing, so it is not named.
          { name: 'drafts', ...plugin, enabled: true },
        ]);
        yield* enablePlugin(
          'notes',
          { globalState, globalStorage: pluginDir },
          () => Effect.succeed(true),
        ).pipe(Effect.provide(NodeFileSystem.layer));
        const { executeCliToolUseConfig } =
          yield* Effect.promise(loadExecuteCli);
        mocks.rootLaunch.mockResolvedValueOnce({
          outcome: 'completed',
          output: {
            response: 'Done.',
            files: [],
          },
          runId: 'exec-1',
        });
        mocks.readCliRunOutcomeState.mockResolvedValueOnce({
          outcome: 'completed',
          outcomePersisted: true,
        });
        const result = yield* executeCliToolUseConfig(
          toolUseConfig(),
          cliContext(),
          { stopAfterCycle: true },
        );

        expect(result).toMatchObject({
          ok: true,
          exitCode: 0,
          result: {
            outcome: 'completed',
            workingDirectory: '/tmp/project',
            output: { response: 'Done.' },
          },
        });
        if (result.ok) {
          // The result names each installed plugin by where it came from and
          // its pinned commit, never by the local checkout it was read from.
          expect(result.result.plugins).toEqual([
            {
              name: 'notes',
              source: 'https://github.com/example/notes.git',
              commit,
            },
          ]);
          expect(Object.keys(result.result)).toEqual([
            'outcome',
            'output',
            'runId',
            'plugins',
            'workingDirectory',
          ]);
        }
      }),
  );
});
