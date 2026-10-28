import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Predicate,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';

import {
  AgentConfigSchema,
  RUN_OUTCOME,
  type RunId,
  type AgentConfigPayload,
  generateRunId,
  type RunEndResult,
  isLiveRun,
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
  describeFollowUpFailure,
  hasErrorPresentationClaimed,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  SESSION_CLOSE_DEADLINE_MS,
  AgentError,
  isUserAbort,
} from '@texra-ai/harness/host';

import { createHeadlessCliHostInteractions } from './approvalAdapter';
import {
  advertisesInterruptedRun,
  type CheckpointRefinement,
  formatInterruptedResumeHint,
  tryReadCliCwd,
  writeInterruptedResumeHint,
} from './interruptedResumeHint';
import { attachScriptPlainOutput } from './scriptPlainOutput';
import { attachCliSessionProgressProjection } from './sessionProgressSubscription';
import { createCliRuntimeHost } from './cliPresentationHost';
import { CliExitCode } from './exitCodes';
import { writeTextStderr, writeTextStderrAndWait } from './logSinks';
import {
  type CliRunResult,
  readCliPluginPins,
  readCliRunOutcomeState,
  runOutcomeExitCode,
} from './terminalStatus';
import {
  CliUsageError,
  launchApproval,
  launchApprovalNotice,
  projectApprovalPolicy,
  type CliContext,
} from './cliContext';
import type { DatabaseNotOwner } from '@texra-ai/harness/schemas';
import type { LocalSession, SessionOpenError } from '@texra-ai/harness';

/** What a headless run starts: a host's whole configuration (the
 *  `StartInput` arm a host launches with), under the id the CLI minted. */
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
  /** Stop a tool-use run after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Called during signal shutdown once the run's CANCELLED end is
   *  committed and its rows say it can be resumed, before the signal
   *  handler exits. */
  readonly onInterruptedRunFinalized?: (runId: RunId) => Effect.Effect<void>;
  /** Refine generic flow resumability for the launched workflow's state. */
  readonly canAdvertiseInterruptedRun?: CheckpointRefinement;
  /** What the command does with the run once its end is committed (a
   *  document task's output copy and result record), with its committed
   *  outcome: part of the finalization a shutdown waits for, so a signal
   *  never cuts it short. Its failure fails the finalization. */
  readonly afterRun?: (result: RunEndResult) => Effect.Effect<void, Error>;
  /** The persisted run `texra resume` continues through the session's
   *  resume; unset, the run starts fresh under a minted id. */
  readonly runId?: RunId;
}

export type CliConfigExecuteResult =
  | {
      readonly ok: true;
      readonly outcomePersisted: boolean;
      readonly result: CliRunResult;
    }
  | {
      readonly ok: false;
      readonly exitCode: CliExitCode;
    };

/** A tool-use run (`texra run` on an agent with no task, `texra team run`):
 *  one model/tool cycle, with the session resume hint on an interrupt. */
export function executeCliToolUseConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: {
    readonly services: CliExecuteOptions['services'];
    /** False when invocation-owned temporary inputs will not survive exit. */
    readonly recoveryInputIsDurable: boolean;
  },
) {
  return Effect.gen(function* () {
    const recoveryProcessCwd = tryReadCliCwd();
    const workingDirectory = config.workingDirectory || runContext.cwd;
    const run = yield* executeCliConfig(config, runContext, {
      services: options.services,
      stopAfterCycle: true,
      onInterruptedRunFinalized: options.recoveryInputIsDurable
        ? (runId) =>
            writeInterruptedResumeHint(
              formatInterruptedResumeHint(
                runContext,
                runId,
                'session',
                workingDirectory,
                recoveryProcessCwd,
              ),
              true,
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
  });
}

/** How a headless run enters its session: `texra resume`'s resume of the
 *  persisted run (a refusal is the caller's usage exit), or a fresh start
 *  with the approval it rides (`launchApproval`). */
function launchOn(
  session: Session,
  request: CliRunRequest,
  runContext: CliContext,
  options: CliExecuteOptions,
): Effect.Effect<Run, Error> {
  if (options.runId !== undefined)
    return session.resume(options.runId).pipe(
      Effect.catchTag('ResumeRefused', (refusal) =>
        Effect.fail(
          new CliUsageError({
            message: describeFollowUpFailure(refusal.reason),
          }),
        ),
      ),
    );
  const approval = launchApproval(runContext.requestedApprovalPolicy);
  return session.start({
    config: request.config,
    runId: request.runId,
    approval: {
      policy: approval.approvalPolicy,
      delegated: approval.approveDelegatedWork,
    },
    interactive: options.stopAfterCycle !== true,
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
export function executeCliConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliExecuteOptions,
): Effect.Effect<CliConfigExecuteResult, Error, ProcessServices> {
  return Effect.gen(function* () {
    const parsed = Schema.decodeUnknownResult(AgentConfigSchema)(config);
    if (!Result.isSuccess(parsed)) {
      writeTextStderr(`Invalid configuration: ${parsed.failure.message}`);
      return { ok: false as const, exitCode: CliExitCode.Usage };
    }
    // The run id is decided before launch: a shutdown stops the launch
    // through the session's registry under it (`runs.stop`), which the
    // launch tracks (or attaches to a parked predecessor) before the first
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
    const host = yield* createHeadlessCliHostInteractions(session, runContext, {
      prompting: () => presentationHost.holdForPrompt?.(),
      emit: (event, payload) => {
        if (event === 'requestShowError') failurePresented = true;
        presentationHost.emit(event, payload);
      },
    }).pipe(Scope.provide(presentationScope));
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
    // What a shutdown found: nothing yet, the launch still entering the
    // session (its fiber is interrupted, which aborts it), or the run
    // admitted (stopped through the session, its end committed by the run).
    let shutdownRequested = false;
    let admitted = false;
    let ended = false;
    const shutdownFinalizationDone = Deferred.makeUnsafe<void>();
    /** The run's end as the view folds it: a level that holds the run (its
     *  committed opening always folds) and shows it no longer live here, or
     *  one without it once it was seen or once its rows are gone (it was
     *  deleted). The wait also ends with the session's fold. */
    const settledHere = (runId: RunId): Effect.Effect<void> =>
      Effect.suspend(() => {
        let seen = false;
        return session.view.changes.pipe(
          Stream.filterEffect((view) => {
            const run = view.runs.get(runId);
            if (run !== undefined) {
              seen = true;
              return Effect.succeed(!run.ownedHere || !isLiveRun(run));
            }
            if (seen) return Effect.succeed(true);
            // Not folded yet, or deleted before it was: its rows decide.
            return session
              .records(runId)
              .exists()
              .pipe(
                Effect.map((exists) => !exists),
                Effect.catch((error) =>
                  sayShutdownFailure(
                    `Whether run ${runId} still exists could not be read; its drain goes on without waiting`,
                    toErrorMessage(error),
                  ).pipe(Effect.as(true)),
                ),
              );
          }),
          Stream.runHead,
          Effect.asVoid,
        );
      });
    const recoveryNoticeStarted = Deferred.makeUnsafe<void>();
    /** The run's admission and its committed end, on a fiber a shutdown
     *  that comes before admission interrupts. */
    const launched = yield* Effect.forkChild(
      Effect.suspend(() =>
        launchOn(session, request, runContext, options),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            admitted = true;
          }),
        ),
        Effect.flatMap((run) => run.result),
      ),
    );
    const shutdownStatus = Effect.suspend(() =>
      Effect.gen(function* () {
        shutdownRequested = true;
        // Headless shutdown cascades into active children: a detached child
        // cannot outlive the exiting CLI process, so the detach-on-stop
        // toggle is not consulted here.
        yield* withProcessServices(
          options.services.runtime,
          Effect.gen(function* () {
            // The run has ended: what is left is its finalization (the
            // recovery notice, a document task's output copy), which the
            // handler waits for whole, so a copy is never cut short.
            if (ended) {
              yield* Effect.uninterruptible(
                Deferred.await(shutdownFinalizationDone),
              );
              return;
            }
            // Before admission the launch is aborted; one born all the same
            // is drained by the finalization, which the handler waits for
            // so its recovery notice lands before the sessions close.
            if (!admitted) {
              yield* Fiber.interrupt(launched);
              yield* Effect.uninterruptible(
                Deferred.await(shutdownFinalizationDone),
              );
              return;
            }
            const stopped = yield* session
              .request({
                kind: 'run.stop',
                runId: launchRunId,
                detachActiveChildren: false,
                reason: 'shutdown',
              })
              .pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  sayShutdownFailure(
                    `Run ${launchRunId} was not stopped for the shutdown`,
                    toErrorMessage(error),
                  ).pipe(Effect.as(false)),
                ),
              );
            // A stop that reached no live run (it had ended) promises no
            // recovery: the run's own end is what the handler waits for.
            // Decided here, from the rows before the run's end, and again by
            // the finalization's drain after it: this early verdict is what
            // lets the wait below outrank the deadline, which a verdict read
            // after the end could not. When it cannot be read the ordinary
            // bounded path below remains authoritative (its race still sees
            // the drain start a notice), and the shutdown says so.
            const advertisesCheckpoint =
              stopped &&
              (yield* session
                .records(launchRunId)
                .readResumable()
                .pipe(
                  Effect.flatMap((inspection) =>
                    advertisesInterruptedRun(
                      launchRunId,
                      inspection,
                      options.canAdvertiseInterruptedRun,
                    ),
                  ),
                  Effect.catch((error) =>
                    sayShutdownFailure(
                      `Run ${launchRunId}: whether it can be resumed could not be read before shutdown; its recovery notice waits only within the shutdown deadline`,
                      toErrorMessage(error),
                    ).pipe(Effect.as(false)),
                  ),
                ));
            // Wait for the run's end and its recovery notice before the
            // handler exits. A resumable run keeps shutdown alive until the
            // promised notice is flushed: that wait outranks the deadline.
            if (advertisesCheckpoint && options.onInterruptedRunFinalized) {
              yield* Effect.uninterruptible(
                Deferred.await(shutdownFinalizationDone),
              );
              return;
            }
            const first = yield* Effect.raceAll([
              Deferred.await(shutdownFinalizationDone).pipe(
                Effect.as('finalized' as const),
              ),
              ...(options.onInterruptedRunFinalized
                ? [
                    Deferred.await(recoveryNoticeStarted).pipe(
                      Effect.as('recovery-started' as const),
                    ),
                  ]
                : []),
            ]);
            if (first === 'recovery-started') {
              yield* Effect.uninterruptible(
                Deferred.await(shutdownFinalizationDone),
              );
            }
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
    let shutdownStatusArmed = true;
    yield* Scope.addFinalizer(
      shutdownStatusScope,
      Effect.suspend(() =>
        shutdownStatusArmed ? shutdownStatus : Effect.void,
      ).pipe(
        // The step's one deadline: the same budget a session close spends,
        // so a run that never unwinds cannot hold SIGTERM open. Its
        // uninterruptible wait for a promised recovery notice still finishes.
        Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
        Effect.catchCause((cause) =>
          sayShutdownFailure(
            "The run's shutdown step failed; the exit does not wait for its recovery notice",
            Cause.pretty(cause),
          ),
        ),
      ),
    );

    // A finalization notice is not the run's own failure, so it goes
    // straight to this host and never sets `failurePresented` (§15).
    const reportFinalizationFailure = (error: unknown): void => {
      presentationHost.emit('requestShowError', {
        message: toErrorMessage(error),
      });
    };
    let runResult:
      | { readonly ok: true; readonly result: RunEndResult }
      | { readonly ok: false } = { ok: false };
    let primaryRunFailure: { readonly error: unknown } | undefined;
    let shutdownLaunchAborted = false;
    let refusal: CliUsageError | undefined;
    // Closing a closed scope is a no-op: the early close below is taken only
    // on a path that then throws or returns before the success tail that
    // `ensuring`s it.
    const detachPresentation = Scope.close(presentationScope, Exit.void);
    const exit = yield* Fiber.await(launched);
    ended = true;
    // A run the shutdown stopped after admission ends CANCELLED; only a
    // launch the shutdown interrupted ends interrupted.
    let interrupted = false;
    if (Exit.isSuccess(exit)) {
      runResult = { ok: true as const, result: exit.value };
    } else if (shutdownRequested && Cause.hasInterruptsOnly(exit.cause)) {
      interrupted = true;
      shutdownLaunchAborted = !admitted;
    } else {
      const failure = Cause.squash(exit.cause);
      // The session words a launch's failure as a `RunFailure`; what it
      // failed with is its cause.
      const err = failure instanceof RunFailure ? failure.cause : failure;
      // Only a classified, already-handled AgentError resolves to a non-zero
      // exit code here; anything else (e.g. registerRun disk I/O,
      // workspaceState.update failures) is unexpected and must keep
      // propagating to bin/texra.ts's crash handler.
      if (shutdownRequested && isUserAbort(err)) {
        interrupted = true;
        shutdownLaunchAborted = !admitted;
      } else if (err instanceof CliUsageError) {
        refusal = err; // a refused resume: the caller's usage exit
      } else {
        // A failure before the run opened is the caller's to present (the
        // session presents none); one after it carries the session
        // presenter's receipt, and one that presented itself through a
        // targeted notification is marked claimed at its throw site.
        if (!(err instanceof AgentError)) primaryRunFailure = { error: err };
        else if (!failurePresented && !hasErrorPresentationClaimed(err))
          presentationHost.emit('requestShowError', {
            message: toErrorMessage(err),
          });
      }
    }

    const finalization = yield* Effect.result(
      Effect.gen(function* () {
        // A run the shutdown stopped (it ended cancelled, or its result
        // could not be read) has committed rows that say whether it can be
        // resumed: read once its end is committed, and the recovery notice
        // written from them. A drain that fails fails the run's
        // finalization, after its end.
        // A launch the shutdown interrupted may have been admitted all the
        // same (the interrupt landed in the admission's tail, which stops
        // the run): its rows decide, once its end is committed.
        const born =
          shutdownLaunchAborted &&
          (yield* session.records(launchRunId).exists());
        if (born) yield* settledHere(launchRunId);
        const stopped =
          shutdownRequested &&
          (born ||
            (!shutdownLaunchAborted &&
              (!runResult.ok ||
                runResult.result.outcome === RUN_OUTCOME.CANCELLED)));
        if (stopped) {
          const drain = Effect.gen(function* () {
            const resumability = yield* session
              .records(launchRunId)
              .readResumable();
            const onFinalized = options.onInterruptedRunFinalized;
            if (
              onFinalized !== undefined &&
              (yield* advertisesInterruptedRun(
                launchRunId,
                resumability,
                options.canAdvertiseInterruptedRun,
              ))
            ) {
              yield* Deferred.succeed(recoveryNoticeStarted, undefined);
              yield* onFinalized(launchRunId);
            }
          });
          // A run another owner holds now is that owner's to finalize.
          yield* drain.pipe(
            Effect.catch((error: unknown) =>
              Predicate.isTagged(
                error,
                'DatabaseNotOwner' satisfies DatabaseNotOwner['_tag'],
              )
                ? Effect.void
                : Effect.fail(ensureError(error)),
            ),
          );
        }
        // A failed run's end reaches the host through the session's
        // presenter, which `settled` waits for: the presentation host stays
        // attached until it has.
        yield* session.settled;
        if (!runResult.ok) return undefined;
        const state = yield* readCliRunOutcomeState(
          session,
          runResult.result,
          reportFinalizationFailure,
        );
        if (options.afterRun)
          yield* options.afterRun({
            ...runResult.result,
            outcome: state.outcome,
          });
        return state;
      }),
    );
    Deferred.doneUnsafe(shutdownFinalizationDone, Effect.void);
    // Disarmed only now: a signal during the finalization waits for it.
    shutdownStatusArmed = false;
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

    return yield* Effect.sync(() => {
      const { outcome, outcomePersisted } = finalization.success!;
      return {
        ok: true as const,
        outcomePersisted,
        result: { ...runResult.result, outcome, plugins },
      };
    }).pipe(Effect.ensuring(detachPresentation));
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}
