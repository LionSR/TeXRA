import { Cause, Deferred, Effect, Exit, Result, Scope } from 'effect';

import { RUN_OUTCOME, type RunId } from '@texra-ai/harness/schemas';
import { withProcessServices, type ProcessRuntime } from '@texra-ai/harness';
import {
  runAgent,
  SESSION_CLOSE_DEADLINE_MS,
  type SessionHandle,
  terminalFailurePresented,
  validateRunRequest,
  type AgentConfigPayload,
  type RunAgentOptions,
  type RunAgentRequest,
} from '@agent/runtime';
import { deriveResumability, finalizeRun } from '@agent/storage';
import { AgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import {
  DatabaseNotOwner,
  type SessionOpenError,
} from '@shared/session/database';
import { aggregateError, generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

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
import { writeTextStderr } from './logSinks';
import {
  type CliRunResult,
  readCliPluginPins,
  readCliRunOutcomeState,
  runOutcomeExitCode,
  type ExecuteAgentResult,
} from './terminalStatus';
import { CliUsageError, type CliContext } from './cliContext';

type RunAgentWorkflowOutput = NonNullable<
  RunAgentOptions['publishWorkflowOutput']
>;

/**
 * The process services a headless run requires (the ones `runAgent` reads),
 * derived rather than named so the host imports no agent-internal module.
 */
export type CliRunServices = Effect.Services<ReturnType<typeof runAgent>>;
type CliWorkflowOutputHandler = (
  result: Parameters<RunAgentWorkflowOutput>[0],
  /** The declared defaults the run hands over; see `RunAgentOptions`. */
  agentDefaultOutputFiles: Parameters<RunAgentWorkflowOutput>[1],
  tryCommitPublication: () => boolean,
) => Effect.Effect<Effect.Success<ReturnType<RunAgentWorkflowOutput>>, Error>;

interface CliExecuteOptions {
  /** The process session the run executes under: `initCliPlatform`'s one
   *  memoized open, threaded from the command that holds its services. */
  readonly session: Effect.Effect<SessionHandle, SessionOpenError>;
  /** The process runtime, from the same services: the shutdown step below
   *  runs on the process's shutdown fiber, so it runs its programs on this. */
  readonly runtime: ProcessRuntime;
  /** The process's shutdown scope, from the same services: the run's
   *  shutdown-status step is a finalizer of a child scope of it, so it runs
   *  before the sessions close. */
  readonly shutdownScope: Scope.Scope;
  /** Stop a tool-use run after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Workflow output handler extended with the CLI publication gate; attempt
   *  the commit synchronously once before destination validation or I/O. */
  readonly publishWorkflowOutput?: CliWorkflowOutputHandler;
  /** Called during signal shutdown after CANCELLED status is durable and the
   *  resumable checkpoint has been drained, before the signal handler exits. */
  readonly onInterruptedRunFinalized?: (runId: RunId) => Effect.Effect<void>;
  /** Refine generic flow resumability for the launched workflow's state. */
  readonly canAdvertiseInterruptedRun?: CheckpointRefinement;
  /** The agent boundary the request runs through: unset, the runtime's own;
   *  `texra resume`'s is the core resume path, which reads the shutdown
   *  predicate; a test harness injects stand-ins rather than mocking. */
  readonly agentRuns?: Partial<{
    readonly launch: (shutdown: () => boolean) => typeof runAgent;
    readonly finalize: typeof finalizeRun;
    readonly resumability: typeof deriveResumability;
  }>;
}

export interface CliConfigExecuteOptions extends CliExecuteOptions {
  /**
   * The persisted run a resume continues, instead of minting a fresh id; its
   * `agentRuns.launch` is the resume path.
   */
  readonly runId?: RunId;
}

export type CliConfigExecuteResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly outcomePersisted: boolean;
      readonly result: CliRunResult;
    }
  | {
      readonly ok: false;
      readonly exitCode: CliExitCode;
    };

/**
 * Build and validate a headless CLI run request, then run it. Command
 * handlers own command-specific config construction; this module owns the
 * common request lifecycle so document task, chat and team runs cannot
 * drift on validation or run ids.
 */
export function executeCliConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions,
): Effect.Effect<CliConfigExecuteResult, Error, CliRunServices> {
  return Effect.gen(function* () {
    const { runId: resumedRunId, ...executeOptions } = options;
    const runId = resumedRunId ?? generateRunId();
    const validation = validateRunRequest({ config });
    if (!validation.valid) {
      writeTextStderr(validation.message);
      return { ok: false as const, exitCode: CliExitCode.Usage };
    }

    const plugins = yield* readCliPluginPins((yield* options.session).roots);
    const request = { ...validation.request, runId };
    const run = yield* executeCliRequest(request, runContext, executeOptions);
    if (!run.ok) {
      return run;
    }
    return {
      ok: true as const,
      runId,
      outcomePersisted: run.outcomePersisted,
      result: { ...run.result, plugins },
    };
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}

export function executeCliToolUseConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions & {
    /** False when invocation-owned temporary inputs will not survive exit. */
    readonly recoveryInputIsDurable?: boolean;
  },
) {
  return Effect.gen(function* () {
    const { recoveryInputIsDurable = true, ...executeOptions } = options;
    const recoveryProcessCwd = tryReadCliCwd();
    const workingDirectory = config.workingDirectory || runContext.cwd;
    const run = yield* executeCliConfig(config, runContext, {
      ...executeOptions,
      onInterruptedRunFinalized:
        recoveryInputIsDurable === true
          ? (executeOptions.onInterruptedRunFinalized ??
            ((runId) =>
              writeInterruptedResumeHint(
                formatInterruptedResumeHint(
                  runContext,
                  runId,
                  'session',
                  workingDirectory,
                  recoveryProcessCwd,
                ),
                true,
              )))
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

/**
 * Shared headless-run skeleton for `run` and `team run`: stand up a
 * runtime host, run the request, always close the host, and resolve the
 * terminal outcome.
 * Centralizing this stops the runners from drifting apart on host
 * lifecycle and outcome handling, which is how their behavior diverged before.
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
export function executeCliRequest(
  // The run id is decided before launch: a shutdown stops the launch through
  // the session's registry under it (`runs.stop`), which `runAgent` tracks
  // (or attaches to a parked predecessor) before the first resume lineage
  // read, so this kill has a target from that first await on.
  request: RunAgentRequest & { readonly runId: RunId },
  runContext: CliContext,
  options: CliExecuteOptions,
): Effect.Effect<
  | {
      ok: true;
      outcomePersisted: boolean;
      result: ExecuteAgentResult;
    }
  | { ok: false; exitCode: CliExitCode },
  Error,
  CliRunServices
> {
  return Effect.gen(function* () {
    const agentRuns = {
      launch: () => runAgent,
      finalize: finalizeRun,
      resumability: deriveResumability,
      ...options.agentRuns,
    };
    const session = yield* options.session;
    session.setApprovalPolicy(runContext.approvalPolicy);
    const presentationHost = createCliRuntimeHost(runContext);
    // Everything the run attaches to the session for its output: closed once,
    // after the last result read, so the last line is on the wire before the
    // result record. Finalizers run last-attached first.
    const presentationScope = yield* Scope.make();
    yield* Scope.addFinalizer(presentationScope, presentationHost.close());
    let failurePresented = false;
    const renderWorkflowPlainProgress =
      runContext.outputFormat === 'text' &&
      runContext.renderRunProgress === true;
    yield* presentationHost
      .attachRunProgressRenderer(session, { runId: request.runId })
      .pipe(Scope.provide(presentationScope));
    const detachHostInteractions = yield* session.interactions.use(
      createHeadlessCliHostInteractions(session, options.runtime, runContext, {
        beforePrompt: () => presentationHost.prepareInteractivePrompt?.(),
        emit: (event, payload) => {
          if (event === 'requestShowError') failurePresented = true;
          presentationHost.emit(event, payload);
        },
      }),
    );
    yield* Scope.addFinalizer(
      presentationScope,
      Effect.sync(detachHostInteractions),
    );
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
    let ownedRunId: RunId | undefined;
    let shutdownRequested = false;
    // Workflow-output publication and shutdown-driven interruption race on the
    // same synchronous tick (see tryCommitWorkflowOutputPublication and the
    // onShutdown handler below): at most one may own the terminal verdict for
    // this launch. One variable makes "both committed and interrupted"
    // unrepresentable; the artifact-failure and report-dedupe bookkeeping are
    // only ever meaningful once interrupted, so they live on that variant.
    type LaunchVerdict =
      | { readonly kind: 'undecided' }
      | { readonly kind: 'published' }
      | {
          readonly kind: 'interrupted';
          artifactFailure: unknown;
          finalizationFailureReported: boolean;
        };
    let launchVerdict: LaunchVerdict = { kind: 'undecided' };
    // The lifecycle's `report` port is a plain callback the run loop calls as
    // it settles, routed straight to this host rather than through the session
    // attachment: a finalization notice is not the run's own failure, so it
    // must not set `failurePresented` and suppress the `AgentError` below (§15).
    const reportFinalizationFailure = (error: unknown): void => {
      presentationHost.emit('requestShowError', {
        message: toErrorMessage(error),
      });
    };
    const reportShutdownFinalizationFailure = (error: Error): void => {
      if (
        launchVerdict.kind !== 'interrupted' ||
        launchVerdict.finalizationFailureReported
      ) {
        return;
      }
      launchVerdict.finalizationFailureReported = true;
      reportFinalizationFailure(error);
    };
    const shutdownFinalizationDone = Deferred.makeUnsafe<void>();
    const recoveryNoticeStarted = Deferred.makeUnsafe<void>();
    // Both callbacks enter on this event loop, and neither yields between the
    // check and assignment. Exactly one can therefore own the terminal verdict.
    const tryCommitWorkflowOutputPublication = (): boolean => {
      if (launchVerdict.kind === 'interrupted') return false;
      launchVerdict = { kind: 'published' };
      return true;
    };
    const shutdownStatusFinalized = yield* Effect.cached(
      Effect.gen(function* () {
        // Both call sites run after runAgent has taken (or failed to take)
        // the run's claim, so the plain variable is the settled answer.
        const runId = ownedRunId;
        if (!runId) return false;
        const onFinalized = options.onInterruptedRunFinalized;
        const drain = Effect.gen(function* () {
          const terminalStatusPersisted = (yield* agentRuns.finalize(session, {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            report: reportShutdownFinalizationFailure,
          })).ok;
          yield* session.commitRunEnd(runId);
          const resumability = terminalStatusPersisted
            ? yield* agentRuns.resumability(runId, session)
            : undefined;
          // The run's end committed above: the checkpoint alone decides the notice.
          if (onFinalized !== undefined) {
            const advertise = yield* advertisesInterruptedRun(
              runId,
              resumability,
              options.canAdvertiseInterruptedRun,
            );
            if (advertise) {
              yield* Deferred.succeed(recoveryNoticeStarted, undefined);
              yield* onFinalized(runId);
            }
          }
          return true;
        });
        // Record the original drain failure for the one-shot runtime adapter
        // below, which rethrows it into runAgent's artifact aggregate. This
        // memoized operation itself resolves false so the outer shutdown await
        // cannot rethrow the same error over the primary run failure.
        return yield* drain.pipe(
          Effect.catch((error: unknown) =>
            Effect.sync(() => {
              if (
                !(error instanceof DatabaseNotOwner) &&
                launchVerdict.kind === 'interrupted'
              ) {
                launchVerdict.artifactFailure = error;
              }
              return false;
            }),
          ),
        );
      }),
    );
    /** Memoized: the first interrupted caller drains; later ones read that
     *  answer. An uninterrupted launch has nothing to finalize. */
    const finalizeShutdownStatus = Effect.suspend(() =>
      launchVerdict.kind === 'interrupted'
        ? shutdownStatusFinalized
        : Effect.succeed(false),
    );
    const shutdownStatus = Effect.suspend(() =>
      Effect.gen(function* () {
        shutdownRequested = true;
        // Paired with tryCommitWorkflowOutputPublication: keep this read of
        // launchVerdict and the assignment below in one synchronous turn.
        // Headless shutdown deliberately cascades into active children: a
        // detached child cannot outlive the exiting CLI process, so the
        // detach-on-stop toggle is not consulted here, and this stop's
        // admission is decided before its settlement runs: only a detaching
        // stop waits for the sever to interrupt.
        const stop =
          launchVerdict.kind !== 'published'
            ? session.runs.stop(launchRunId, {
                detachActiveChildren: false,
                reason: 'shutdown',
              })
            : undefined;
        if (stop?.accepted() === true && launchVerdict.kind === 'undecided') {
          launchVerdict = {
            kind: 'interrupted',
            artifactFailure: undefined,
            finalizationFailureReported: false,
          };
        }
        const interruptedRunId =
          launchVerdict.kind === 'interrupted' ? ownedRunId : undefined;
        // Everything the handler still has to wait for is one program over
        // the process services; only the verdict turn above is synchronous.
        yield* withProcessServices(
          options.runtime,
          Effect.gen(function* () {
            if (stop) yield* stop.settlement;
            let advertisesCheckpoint = false;
            if (interruptedRunId) {
              const inspection = yield* Effect.result(
                agentRuns.resumability(interruptedRunId, session),
              );
              // The ordinary bounded shutdown path below remains authoritative
              // when checkpoint inspection itself is unavailable.
              advertisesCheckpoint =
                Result.isSuccess(inspection) &&
                (yield* advertisesInterruptedRun(
                  interruptedRunId,
                  inspection.success,
                  options.canAdvertiseInterruptedRun,
                ).pipe(Effect.orElseSucceed(() => false)));
            }
            // Earlier shutdown handlers interrupt the live agent sessions. Wait
            // for runAgent to finish unwinding before the final drain commits
            // the run's ending, so no transcript or checkpoint writer can race
            // it. This step's deadline bounds this wait by interrupting it.
            // Once durable resumability has been established, however, keep
            // shutdown alive
            // until the promised recovery notice has been flushed — that wait
            // is uninterruptible precisely because it outranks the deadline.
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
    // scope, so a shutdown runs this step
    // before it closes the sessions; closed with the step disarmed once the
    // run has settled here, so a completed run leaves nothing behind.
    const shutdownStatusScope = yield* Scope.fork(options.shutdownScope);
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
          Effect.logError("The run's shutdown step failed").pipe(
            Effect.annotateLogs({ data: Cause.squash(cause) }),
          ),
        ),
      ),
    );
    const publishWorkflowOutput = options.publishWorkflowOutput;
    const invoke = (): ReturnType<typeof runAgent> =>
      agentRuns.launch(() => shutdownRequested)(request, {
        session,
        publishWorkflowOutput:
          publishWorkflowOutput === undefined
            ? undefined
            : (result, agentDefaultOutputFiles) =>
                publishWorkflowOutput(
                  result,
                  agentDefaultOutputFiles,
                  tryCommitWorkflowOutputPublication,
                ),
        beforeRunEnd: () =>
          Effect.gen(function* () {
            const handled = yield* finalizeShutdownStatus;
            if (
              launchVerdict.kind === 'interrupted' &&
              launchVerdict.artifactFailure !== undefined
            ) {
              const error = launchVerdict.artifactFailure;
              launchVerdict.artifactFailure = undefined;
              return yield* Effect.fail(ensureError(error));
            }
            return handled;
          }),
        onRunClaimed: (runId) => {
          ownedRunId = runId;
        },
        stopAfterCycle: options.stopAfterCycle,
      });

    let runResult:
      | { readonly ok: true; readonly result: ExecuteAgentResult }
      | { readonly ok: false } = { ok: false };
    let primaryRunFailure: { readonly error: unknown } | undefined;
    let shutdownLaunchAborted = false;
    let refusal: CliUsageError | undefined;
    // Closing a closed scope is a no-op: the early close below is taken only
    // on a path that then throws or returns before the success tail that
    // `ensuring`s it.
    const detachPresentation = Scope.close(presentationScope, Exit.void);
    const invocation = yield* Effect.result(
      Effect.suspend(invoke).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(ensureError(Cause.squash(cause))),
        ),
      ),
    );
    if (Result.isSuccess(invocation)) {
      runResult = { ok: true as const, result: invocation.success };
    } else {
      const err = invocation.failure;
      // Only a classified, already-handled AgentError resolves to a non-zero
      // exit code here; anything else (e.g. registerRun disk I/O,
      // workspaceState.update failures) is unexpected and must keep
      // propagating to bin/texra.ts's crash handler.
      if (shutdownRequested && isUserAbort(err)) {
        shutdownLaunchAborted = true;
      } else if (err instanceof CliUsageError) {
        refusal = err; // a refused resume: the caller's usage exit
      } else if (!(err instanceof AgentError)) {
        primaryRunFailure = { error: err };
      } else if (
        !failurePresented &&
        !hasErrorPresentationClaimed(err) &&
        !terminalFailurePresented(err)
      ) {
        // A failure before registration (agent or model resolution) has no
        // `result` event; one after registration carries the session
        // presenter's receipt. A launch failure that already presented itself
        // through a targeted notification (model-not-recognized,
        // agent-not-found) is marked claimed at its throw site -- this
        // CLI-local flag only tracks `requestShowError`, so it would otherwise
        // re-surface that failure a second time here.
        yield* session.interactions.emit('requestShowError', {
          message: toErrorMessage(err),
        });
      }
    }

    shutdownStatusArmed = false;
    yield* Scope.close(shutdownStatusScope, Exit.void);
    const finalization = yield* Effect.result(
      Effect.gen(function* () {
        yield* finalizeShutdownStatus;
        yield* session.settlePublications();
        if (runResult.ok) {
          return yield* readCliRunOutcomeState(
            session,
            runResult.result,
            reportFinalizationFailure,
          );
        }
        return undefined;
      }),
    );
    Deferred.doneUnsafe(shutdownFinalizationDone, Effect.void);
    if (!runResult.ok || Result.isFailure(finalization)) {
      yield* detachPresentation;
    }
    if (Result.isFailure(finalization)) {
      return yield* Effect.die(
        primaryRunFailure
          ? aggregateError(
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
        exitCode: shutdownLaunchAborted
          ? CliExitCode.Interrupted
          : runOutcomeExitCode(RUN_OUTCOME.FAILED),
      };
    }

    return yield* Effect.sync(() => {
      const { outcome, outcomePersisted } = finalization.success!;
      return {
        ok: true as const,
        outcomePersisted,
        result: { ...runResult.result, outcome },
      };
    }).pipe(Effect.ensuring(detachPresentation));
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}
