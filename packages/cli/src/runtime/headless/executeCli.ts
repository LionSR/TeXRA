import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Result,
  Scope,
  Stream,
} from 'effect';

import {
  RUN_OUTCOME,
  type RunId,
  type AgentConfigPayload,
  generateRunId,
  ensureError,
  programOf,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import {
  LaunchRefused,
  RunFailure,
  type Run,
  type Session,
  type StartInput,
} from '@texra-ai/harness';
import {
  presentRunFailure,
  type ProcessServices,
  AgentError,
} from '@texra-ai/harness/host';
import { SESSION_CLOSE_DEADLINE_MS } from '@texra-ai/harness/plugins';
import type { CliRunResult } from '@cli/schemas/cliOutput';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';

import { createHeadlessCliHostInteractions } from './approvalAdapter';
import {
  formatInterruptedResumeHint,
  tryReadCliCwd,
} from './interruptedResumeHint';
import { attachScriptPlainOutput } from './scriptPlainOutput';
import { attachCliSessionProgressProjection } from './sessionProgressSubscription';
import { createCliRuntimeHost } from './cliPresentationHost';
import { shouldRenderRunProgress } from './runProgressRenderer';
import { CliExitCode } from '../platform/exitCodes';
import { writeTextStderr, writeTextStderrAndWait } from '../platform/logSinks';
import { readCliPluginPins, runOutcomeExitCode } from './terminalStatus';
import {
  CliUsageError,
  launchApproval,
  launchApprovalNotice,
  projectApprovalPolicy,
  type CliContext,
  type CliInvocation,
} from '../platform/cliContext';
import type { LocalSession, SessionOpenError } from '@texra-ai/harness';

/** What a headless run starts: a host's whole configuration (the
 *  `StartInput` case a host launches with), under the id the CLI minted. */
type CliRunRequest = Required<
  Pick<Extract<StartInput, { readonly config: unknown }>, 'config' | 'runId'>
>;

export interface CliExecuteOptions {
  /** The `CliPlatform` services the run uses, from the command that
   *  holds them: `session`, where the run starts, resumes and asks its
   *  host, and whose records and rows its output reads; and
   *  `shutdownScope`, of which the run's shutdown-status step is a child
   *  scope's finalizer, so it runs before the sessions close. */
  readonly services: {
    readonly session: Effect.Effect<LocalSession, SessionOpenError>;
    readonly shutdownScope: Scope.Scope;
  };
  /** False when invocation-owned temporary inputs will not survive exit:
   *  a shutdown that leaves the run resumable then prints no resume
   *  command, as nothing could resume it. */
  readonly recoveryInputIsDurable: boolean;
  /** What the command does with the run once its end is committed (a
   *  document task's output copy and result record), with its committed
   *  outcome: part of the finalization a shutdown waits for, so a signal
   *  never cuts it short. Its failure fails the finalization. */
  readonly afterRun?: (result: CliRunResult) => Effect.Effect<void, Error>;
  /** The persisted run `texra resume` continues through the session's
   *  resume; unset, the run starts fresh under a minted id. */
  readonly runId?: RunId;
}

type CliConfigExecuteResult =
  | {
      readonly ok: true;
      readonly result: CliRunResult;
      /** The exit code the run's outcome maps to. */
      readonly exitCode: CliExitCode;
    }
  | {
      readonly ok: false;
      readonly exitCode: CliExitCode;
    };

/** How a headless run enters its session: `texra resume`'s resume of the
 *  persisted run (a refusal is the caller's usage exit), or a fresh start
 *  with the approval it rides (`launchApproval`). Either is one cycle
 *  long: neither is `interactive`. */
function launchOn(
  session: Session,
  request: CliRunRequest,
  runContext: CliContext,
  options: CliExecuteOptions,
): Effect.Effect<Run, Error> {
  if (options.runId !== undefined)
    return session
      .resume(options.runId)
      .pipe(
        Effect.catchTag('ResumeRefused', ({ message }) =>
          Effect.fail(new CliUsageError({ message })),
        ),
      );
  return session.start({
    config: request.config,
    runId: request.runId,
    approval: launchApproval(runContext.requestedApprovalPolicy),
  });
}

/**
 * Validate a headless CLI run's configuration and run it: stand up a runtime
 * host, run the request, always close the host, and resolve the terminal
 * outcome. Command handlers own command-specific config construction; this
 * owns the common request lifecycle, so document task and chat runs
 * cannot drift on validation, run ids, host lifecycle or outcome handling.
 *
 * A classified run failure (AgentRunLifecycle already ran it through
 * `classifyAgentError` and wrote the terminal outcome before rethrowing an
 * `AgentError` for the extension host) is consumed here into a non-zero exit
 * code instead of being rethrown — otherwise it reaches `bin/texra.ts`'s
 * crash handler and gets misreported as an unexpected crash, printed a
 * second time alongside a "please report it" line (issue #7645). Only
 * `AgentError` — the classified, already-handled shape — takes this path;
 * any other rejection (e.g. `registerRun` disk I/O, `workspaceState.update`
 * failures) is genuinely unexpected and is rethrown so the crash handler
 * still reports it.
 */
export const executeCliConfig: (
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliExecuteOptions,
) => Effect.Effect<
  CliConfigExecuteResult,
  Error,
  ProcessServices | CliInvocation
> = Effect.fn('executeCliConfig')(
  function* (
    config: AgentConfigPayload,
    runContext: CliContext,
    options: CliExecuteOptions,
  ) {
    // Read before the run: the launch directory may be gone by its end.
    const recoveryProcessCwd = tryReadCliCwd();
    const parsed = yield* Effect.result(decodeLaunchConfig(config));
    if (Result.isFailure(parsed)) {
      writeTextStderr(parsed.failure.reason);
      return { ok: false as const, exitCode: CliExitCode.Usage };
    }
    // The run id is decided before launch, so a shutdown that cuts the
    // launch can still name the run it leaves behind.
    const request: CliRunRequest = {
      config: parsed.success,
      runId: options.runId ?? generateRunId(),
    };
    const session = yield* options.services.session;
    const plugins = yield* readCliPluginPins(session.roots);
    // The run follows the project's setting, read at each decision, with
    // what this invocation asked for riding its launch (`launchApproval`).
    const refused = launchApprovalNotice(
      runContext.requestedApprovalPolicy,
      projectApprovalPolicy(session.roots.config),
    );
    if (refused !== undefined) writeTextStderr(refused);
    const presentationHost = createCliRuntimeHost(runContext);
    // Everything the run attaches to the session for its output: closed once,
    // after the last result read, so the last line is on the wire before the
    // result record. Finalizers run last-attached first.
    const presentationScope = yield* Scope.make();
    yield* Scope.addFinalizer(presentationScope, presentationHost.close());
    let failurePresented = false;
    const renderPlainProgress =
      runContext.outputFormat === 'text' && shouldRenderRunProgress(runContext);
    yield* presentationHost
      .attachRunProgressRenderer(session, request.runId)
      .pipe(Scope.provide(presentationScope));
    const host = yield* createHeadlessCliHostInteractions(session, {
      prompting: () => presentationHost.holdForPrompt?.(),
      emit: (event, payload) => {
        if (event === 'requestShowError') failurePresented = true;
        presentationHost.emit(event, payload);
      },
    });
    yield* session.attach(host).pipe(Scope.provide(presentationScope));
    // A denial has no prompt here to show it: the operator reads the reason
    // its `request.decided` row records as a `[warn]` line, in either output
    // format, as well as in the tool result the model reads.
    yield* Stream.runForEach(
      session.view.events(session.view.head()),
      (event) =>
        Effect.sync(() => {
          if (
            event.type === 'request.decided' &&
            event.decision.action === 'deny'
          )
            writeTextStderr(`[warn] [cli.approval] ${event.decision.reason}`);
        }),
    ).pipe(
      Effect.catch((failure) =>
        Effect.sync(() =>
          writeTextStderr(
            `[warn] [cli.approval] Denied requests are no longer reported: ${toErrorMessage(failure)}`,
          ),
        ),
      ),
      Effect.forkIn(presentationScope),
    );
    if (runContext.outputFormat === 'ndjson') {
      yield* Scope.addFinalizer(
        presentationScope,
        yield* attachCliSessionProgressProjection(session),
      );
    }
    if (renderPlainProgress) {
      yield* attachScriptPlainOutput(session, {
        runId: request.runId,
        beforeWrite: () => presentationHost.prepareInteractivePrompt?.(),
        writeLine: writeTextStderr,
      }).pipe(Scope.provide(presentationScope));
    }
    const launchRunId = request.runId;
    // A shutdown step that fails changes what the exit waits for, so it is
    // said on stderr unless the user passed `--quiet`.
    const sayShutdownFailure = (
      what: string,
      cause: string,
    ): Effect.Effect<void> =>
      runContext.quietLogs
        ? Effect.void
        : writeTextStderrAndWait(`[warn] [cli.shutdown] ${what}: ${cause}`);
    // Whether a shutdown reached this run: its finalization then reads
    // whether the run it left can be resumed.
    let shutdown = false;
    const finalized = yield* Deferred.make<void>();
    /** The run's launch and its committed end, which the session delivers.
     *  A shutdown abandons the wait: the process is going, and the run is
     *  left as its rows stand. */
    const launched = yield* Effect.forkChild(
      Effect.suspend(() =>
        launchOn(session, request, runContext, options),
      ).pipe(
        Effect.flatMap((run) =>
          // The run's whole result, built once: what the command emits and
          // what its `afterRun` finalizes.
          Effect.map(run.result, (end) => ({
            ...end,
            runId: run.runId,
            plugins,
            workingDirectory: runContext.cwd,
          })),
        ),
      ),
    );
    const shutdownStatus = Effect.gen(function* () {
      // The run's finalization is done: nothing is left to wait for.
      if (yield* Deferred.isDone(finalized)) return;
      shutdown = true;
      // Nothing is written for the run: the session's close, which follows
      // this step, interrupts it, and it reads as interrupted, resumable,
      // at the next open. Only the wait for its end is given up here.
      yield* Fiber.interrupt(launched);
      // The recovery notice and the command's own finalization, within the
      // deadline below.
      yield* Deferred.await(finalized);
    });
    // Registered only once `shutdownStatus` exists: a shutdown scope already
    // closing runs this finalizer at once. A child of the process's shutdown
    // scope, so a shutdown runs this step before it closes the sessions;
    // closed with the step disarmed once the run's finalization is done, so
    // a completed run leaves nothing behind.
    const shutdownStatusScope = yield* Scope.fork(
      options.services.shutdownScope,
    );
    yield* Scope.addFinalizer(
      shutdownStatusScope,
      shutdownStatus.pipe(
        // The step's one deadline: the same budget a session close spends,
        // so a run that never unwinds cannot hold SIGTERM open. Running out
        // of it skips the resume command, so the expiry is said instead.
        Effect.timeoutOrElse({
          duration: SESSION_CLOSE_DEADLINE_MS,
          orElse: () =>
            sayShutdownFailure(
              `The run did not finish stopping within ${SESSION_CLOSE_DEADLINE_MS} ms`,
              `run ${launchRunId} is left as its rows stand; \`${runContext.commandName} history show ${launchRunId}\` says whether it can be resumed`,
            ),
        }),
        Effect.catchCause((cause) =>
          sayShutdownFailure(
            "The run's shutdown step failed; the exit does not wait for its finalization",
            Cause.pretty(cause),
          ),
        ),
      ),
    );

    let runResult:
      | { readonly ok: true; readonly result: CliRunResult }
      | { readonly ok: false } = { ok: false };
    let primaryRunFailure: { readonly error: unknown } | undefined;
    let refusal: CliUsageError | undefined;
    // Closing a closed scope is a no-op: the early close below is taken only
    // on a path that then throws or returns before the success tail that
    // `ensuring`s it.
    const detachPresentation = Scope.close(presentationScope, Exit.void);
    const exit = yield* Fiber.await(launched);
    // An interrupts-only exit after a shutdown is the process's own
    // interruption of the wait (exit 130): the run has no end.
    const interrupted =
      shutdown && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
    if (Exit.isSuccess(exit)) {
      runResult = { ok: true as const, result: exit.value };
    } else if (!interrupted) {
      const failure = Cause.squash(exit.cause);
      // The session words a launch's failure as a `RunFailure` (what it
      // failed with is its cause), or a refused one as `LaunchRefused`.
      const err = failure instanceof RunFailure ? failure.cause : failure;
      // Only a refused launch or a classified, already-handled AgentError
      // resolves to a non-zero exit code here; anything else (e.g.
      // registerRun disk I/O, workspaceState.update failures) is unexpected
      // and must keep propagating to bin/texra.ts's crash handler.
      if (err instanceof CliUsageError) {
        refusal = err; // a refused resume: the caller's usage exit
      } else {
        // A launch that failed before its run opened is the caller's to
        // present (the session presents none), as every host presents one
        // (`presentRunFailure`). A run that opened never fails its launch:
        // its end is its `run.end` row's.
        if (!(err instanceof AgentError || err instanceof LaunchRefused))
          primaryRunFailure = { error: err };
        else if (!failurePresented)
          yield* presentRunFailure(
            {
              emit: (event, payload) =>
                Effect.sync(() => {
                  presentationHost.emit(event, payload);
                }),
            },
            err,
          );
      }
    }

    const finalization = yield* Effect.result(
      Effect.gen(function* () {
        // A run the shutdown left: its committed rows say whether it can be
        // resumed, and the resume command is said on stderr.
        if (
          interrupted &&
          options.recoveryInputIsDurable &&
          (yield* session.records(launchRunId).readContinues)
        )
          yield* writeTextStderrAndWait(
            formatInterruptedResumeHint(
              runContext,
              launchRunId,
              programOf(request.config) === null ? 'session' : 'program',
              config.workingDirectory || runContext.cwd,
              recoveryProcessCwd,
            ),
          );
        // A failed run's end reaches the host through the session's
        // presenter, which `settled` waits for: the presentation host stays
        // attached until it has.
        yield* session.drained;
        if (runResult.ok && options.afterRun)
          yield* options.afterRun(runResult.result);
      }),
    );
    // Done only now: a signal during the finalization waits for it, and the
    // step the close below runs finds nothing left to do.
    yield* Deferred.succeed(finalized, undefined);
    yield* Scope.close(shutdownStatusScope, Exit.void);
    if (!runResult.ok || Result.isFailure(finalization)) {
      yield* detachPresentation;
    }
    if (Result.isFailure(finalization)) {
      return yield* Effect.die(
        primaryRunFailure
          ? new AggregateError(
              [primaryRunFailure.error, finalization.failure],
              'CLI run failed and its final artifacts could not be persisted',
            )
          : finalization.failure,
      );
    }
    if (primaryRunFailure) return yield* Effect.die(primaryRunFailure.error);
    if (refusal) return yield* refusal;
    if (!runResult.ok) {
      return {
        ok: false as const,
        exitCode: interrupted
          ? CliExitCode.Interrupted
          : runOutcomeExitCode(RUN_OUTCOME.FAILED),
      };
    }

    yield* detachPresentation;
    return {
      ...runResult,
      exitCode: runOutcomeExitCode(runResult.result.outcome),
    };
  },
  Effect.catchCause((cause) => Effect.fail(ensureError(cause))),
);
