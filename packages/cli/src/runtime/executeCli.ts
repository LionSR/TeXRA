import { Cause, Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';

import {
  RUN_OUTCOME,
  type RunId,
  type AgentConfigPayload,
  generateRunId,
  ensureError,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import {
  RunFailure,
  type Run,
  type Session,
  type StartInput,
} from '@texra-ai/harness';
import {
  launchNoticeOf,
  normalizeProviderError,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  SESSION_CLOSE_DEADLINE_MS,
  AgentError,
} from '@texra-ai/harness/host';
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
import { CliExitCode } from './exitCodes';
import { writeTextStderr, writeTextStderrAndWait } from './logSinks';
import { readCliPluginPins, runOutcomeExitCode } from './terminalStatus';
import {
  CliUsageError,
  launchApproval,
  launchApprovalNotice,
  projectApprovalPolicy,
  type CliContext,
} from './cliContext';
import type { LocalSession, SessionOpenError } from '@texra-ai/harness';

/** What a headless run starts: a host's whole configuration (the
 *  `StartInput` case a host launches with), under the id the CLI minted. */
type CliRunRequest = Required<
  Pick<Extract<StartInput, { readonly config: unknown }>, 'config' | 'runId'>
>;

export interface CliExecuteOptions {
  /** The `initCliPlatform` services the run uses, from the command that
   *  holds them: `session`, where the run starts, resumes, stops and asks
   *  its host, and whose records and rows its output reads; `runtime`,
   *  which the shutdown
   *  step runs its programs on (it runs on the process's shutdown fiber);
   *  and `shutdownScope`, of which the run's shutdown-status step is a child
   *  scope's finalizer, so it runs before the sessions close. */
  readonly services: {
    readonly session: Effect.Effect<LocalSession, SessionOpenError>;
    readonly runtime: ProcessRuntime;
    readonly shutdownScope: Scope.Scope;
  };
  /** Called once when a shutdown stopped the run, after its end is
   *  committed, if its rows say it can be resumed (`readResumable`): part
   *  of the finalization a shutdown waits for within its deadline. */
  readonly onInterruptedRunFinalized?: (runId: RunId) => Effect.Effect<void>;
  /** What the command does with the run once its end is committed (a
   *  document task's output copy and result record), with its committed
   *  outcome: part of the finalization a shutdown waits for, so a signal
   *  never cuts it short. Its failure fails the finalization. */
  readonly afterRun?: (result: CliRunResult) => Effect.Effect<void, Error>;
  /** The persisted run `texra resume` continues through the session's
   *  resume; unset, the run starts fresh under a minted id. */
  readonly runId?: RunId;
}

export type CliConfigExecuteResult =
  | {
      readonly ok: true;
      readonly result: CliRunResult;
    }
  | {
      readonly ok: false;
      readonly exitCode: CliExitCode;
    };

/** A tool-use run (`texra run` on an agent with no task, `texra team run`):
 *  one model/tool cycle, with the session resume hint on an interrupt. */
export const executeCliToolUseConfig = Effect.fn('executeCliToolUseConfig')(
  function* (
    config: AgentConfigPayload,
    runContext: CliContext,
    options: {
      readonly services: CliExecuteOptions['services'];
      /** False when invocation-owned temporary inputs will not survive exit. */
      readonly recoveryInputIsDurable: boolean;
    },
  ) {
    const recoveryProcessCwd = tryReadCliCwd();
    const workingDirectory = config.workingDirectory || runContext.cwd;
    const run = yield* executeCliConfig(config, runContext, {
      services: options.services,
      onInterruptedRunFinalized: options.recoveryInputIsDurable
        ? (runId) =>
            writeTextStderrAndWait(
              formatInterruptedResumeHint(
                runContext,
                runId,
                'session',
                workingDirectory,
                recoveryProcessCwd,
              ),
            )
        : undefined,
    });
    if (!run.ok) return run;

    const { result } = run;
    return {
      ok: true as const,
      result: {
        ...result,
        workingDirectory: runContext.cwd,
      },
      exitCode: runOutcomeExitCode(result.outcome),
    };
  },
);

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
 * owns the common request lifecycle, so document task, chat and team runs
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
) => Effect.Effect<CliConfigExecuteResult, Error, ProcessServices> = Effect.fn(
  'executeCliConfig',
)(
  function* (
    config: AgentConfigPayload,
    runContext: CliContext,
    options: CliExecuteOptions,
  ) {
    const parsed = yield* Effect.result(decodeLaunchConfig(config));
    if (Result.isFailure(parsed)) {
      writeTextStderr(parsed.failure.reason);
      return { ok: false as const, exitCode: CliExitCode.Usage };
    }
    // The run id is decided before launch: a shutdown stops the launch
    // through the session's registry under it (`runs.stop`), which the
    // launch tracks (or attaches to a waiting predecessor) before the first
    // resume lineage read, so this kill has a target from that first await on.
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
    const renderWorkflowPlainProgress =
      runContext.outputFormat === 'text' && runContext.renderRunProgress;
    yield* presentationHost
      .attachRunProgressRenderer(session, request.runId)
      .pipe(Scope.provide(presentationScope));
    const host = createHeadlessCliHostInteractions(session, runContext, {
      prompting: () => presentationHost.holdForPrompt?.(),
      emit: (event, payload) => {
        if (event === 'requestShowError') failurePresented = true;
        presentationHost.emit(event, payload);
      },
    });
    yield* session.attach(host).pipe(Scope.provide(presentationScope));
    if (runContext.outputFormat === 'ndjson') {
      yield* Scope.addFinalizer(
        presentationScope,
        yield* attachCliSessionProgressProjection(session),
      );
    }
    if (renderWorkflowPlainProgress) {
      yield* attachScriptPlainOutput(session, {
        runId: request.runId,
        beforeWrite: () => presentationHost.prepareInteractivePrompt?.(),
        writeLine: writeTextStderr,
      }).pipe(Scope.provide(presentationScope));
    }
    const launchRunId = request.runId;
    // A shutdown step that fails changes what the exit waits for, so it is
    // said on stderr: the log sink is silent for every CLI command, and
    // `runContext.quietLogs` is forced on for every headless run
    // (`buildHeadlessRunContext`). Only the user's own `--quiet` keeps it
    // unsaid: the log level it set from argv, which that derivation keeps.
    const userQuiet = runContext.minimumLogLevel === 'None';
    const sayShutdownFailure = (
      what: string,
      cause: string,
    ): Effect.Effect<void> =>
      userQuiet
        ? Effect.void
        : writeTextStderrAndWait(`[warn] [cli.shutdown] ${what}: ${cause}`);
    // Whether a shutdown reached this run: its finalization then reads
    // whether the stopped run can be resumed, once its end is committed.
    let shutdown = false;
    const shutdownFinalizationDone = Deferred.makeUnsafe<void>();
    const stopThroughSession = session
      .request({
        kind: 'run.stop',
        runId: launchRunId,
        reason: 'shutdown',
      })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          sayShutdownFailure(
            `Run ${launchRunId} was not stopped for the shutdown`,
            toErrorMessage(error),
          ),
        ),
      );
    // Set as the session's acceptance opens the wait for the run's end,
    // inside that wait's uninterruptible region: an interrupt that landed
    // before it aborted the launch, one after it is answered by the
    // session's stop.
    let accepted = false;
    /** The run's acceptance and its committed end. Once accepted, the end is
     *  the session's to deliver: a shutdown reaches it as a stop, never as an
     *  abandoned wait. */
    const launched = yield* Effect.forkChild(
      Effect.suspend(() =>
        launchOn(session, request, runContext, options),
      ).pipe(
        Effect.flatMap((run) =>
          Effect.uninterruptible(
            Effect.suspend(() => {
              accepted = true;
              return Effect.map(run.result, (end) => ({
                ...end,
                runId: run.runId,
              }));
            }),
          ),
        ),
      ),
    );
    const shutdownStatus = Effect.suspend(
      Effect.fnUntraced(function* () {
        // The run's finalization is done: nothing is left to stop or wait for.
        if (Deferred.isDoneUnsafe(shutdownFinalizationDone)) return;
        shutdown = true;
        // Headless shutdown cascades into active children: a detached child
        // cannot outlive the exiting CLI process, so the detach-on-stop
        // toggle is not consulted here.
        yield* withProcessServices(
          options.services.runtime,
          Effect.gen(function* () {
            // The launch is interrupted where it still can be, before the
            // session accepted the run; one accepted by then, or while the
            // interrupt was on its way, is stopped through the session, which
            // its own end answers (an ended run's stop is the registry's
            // quiet no-op). A launch the session already holds is stopped
            // for the shutdown first, so the run it opens records that, not
            // the launch's release, and resumes as a shutdown's.
            if (!accepted) {
              if (session.held(launchRunId) !== undefined)
                yield* stopThroughSession;
              yield* Effect.forkDetach(Fiber.interrupt(launched));
            }
            // Read again: acceptance may have landed while the interrupt was
            // being forked, and an interrupt that reaches the launch after it
            // waits on the uninterruptible acceptance instead of stopping it.
            if (accepted) yield* stopThroughSession;
            // The run's end, its recovery notice and the command's own
            // finalization, within the deadline below.
            yield* Deferred.await(shutdownFinalizationDone);
          }),
        );
      }),
    );
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
        // so a run that never unwinds cannot hold SIGTERM open.
        Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
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
    // A run the shutdown stopped after the session accepted it stores its
    // cancelled end, which is its result (exit 130, from its outcome). An
    // interrupts-only exit is the shutdown's interrupt: of the launch, which
    // it aborted, or, landing as the accepted wait opened, of the fiber once
    // the stopped run's end let it go (exit 130 as well).
    const interrupted =
      shutdown && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
    if (Exit.isSuccess(exit)) {
      runResult = { ok: true as const, result: exit.value };
    } else if (!interrupted) {
      const failure = Cause.squash(exit.cause);
      // The session words a launch's failure as a `RunFailure`; what it
      // failed with is its cause.
      const err = failure instanceof RunFailure ? failure.cause : failure;
      // Only a classified, already-handled AgentError resolves to a non-zero
      // exit code here; anything else (e.g. registerRun disk I/O,
      // workspaceState.update failures) is unexpected and must keep
      // propagating to bin/texra.ts's crash handler.
      if (err instanceof CliUsageError) {
        refusal = err; // a refused resume: the caller's usage exit
      } else {
        // A launch that failed before its run opened is the caller's to
        // present (the session presents none): a refused launch by the
        // notice it carries, any other by its message and classification,
        // which the host words. A run that opened never fails its launch:
        // its end is its `run.end` row's.
        if (!(err instanceof AgentError)) primaryRunFailure = { error: err };
        else if (!failurePresented) {
          const notice = launchNoticeOf(err);
          if (notice !== undefined)
            presentationHost.emit(notice.event, notice.payload);
          else {
            const { classification } = normalizeProviderError(err);
            presentationHost.emit('requestShowError', {
              message: toErrorMessage(err),
              ...(classification && { classification }),
            });
          }
        }
      }
    }

    const finalization = yield* Effect.result(
      Effect.gen(function* () {
        // A run the shutdown stopped after the session accepted it (it ended
        // cancelled, or its result could not be read): its committed rows
        // say whether it can be resumed, read once its end is committed;
        // rows that cannot be read (logged) say no. A launch the shutdown
        // aborted before acceptance gets no notice: it has no end here to
        // read after.
        const stopped =
          shutdown &&
          accepted &&
          (!runResult.ok || runResult.result.outcome === RUN_OUTCOME.CANCELLED);
        const onFinalized = options.onInterruptedRunFinalized;
        if (
          stopped &&
          onFinalized !== undefined &&
          (yield* session.records(launchRunId).readResumable())
        )
          yield* onFinalized(launchRunId);
        // A failed run's end reaches the host through the session's
        // presenter, which `settled` waits for: the presentation host stays
        // attached until it has.
        yield* session.settled;
        if (runResult.ok && options.afterRun)
          yield* options.afterRun(runResult.result);
      }),
    );
    // Done only now: a signal during the finalization waits for it, and the
    // step the close below runs finds nothing left to do.
    Deferred.doneUnsafe(shutdownFinalizationDone, Effect.void);
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
    if (refusal) return yield* Effect.fail(refusal);
    if (!runResult.ok) {
      return {
        ok: false as const,
        exitCode: interrupted
          ? CliExitCode.Interrupted
          : runOutcomeExitCode(RUN_OUTCOME.FAILED),
      };
    }

    yield* detachPresentation;
    return { ok: true as const, result: { ...runResult.result, plugins } };
  },
  Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
);
