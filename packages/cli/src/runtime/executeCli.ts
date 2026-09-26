import { Cause, Deferred, Effect, Result } from 'effect';

import {
  attachTerminalResultToast,
  runAgent,
  type SessionHandle,
  trackTerminalResultPresentation,
  validateRunRequest,
  type AgentConfigPayload,
  type RunAgentOptions,
  type RunAgentRequest,
} from '@agent/runtime';
import { deriveResumability, finalizeRun } from '@agent/storage';
import { AgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import {
  RUN_OUTCOME,
  type RunEndOutput,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type SessionOpenError,
} from '@shared/session/database';
import { aggregateError, generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { cliToolUseApprovalOptions } from './approval/settleApprovals';
import { createHeadlessCliHostInteractions } from './approvalAdapter';
import {
  advertisesInterruptedRun,
  formatInterruptedResumeHint,
  type ResumableCheckpoint,
  tryReadCliCwd,
  writeInterruptedResumeHint,
} from './interruptedResumeHint';
import { attachWorkflowPlainOutput } from './workflowPlainOutput';
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
import type { CliContext } from './cliContext';

type RunAgentWorkflowOutput = NonNullable<
  RunAgentOptions['openWorkflowOutput']
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
  /** The process runtime, from the same services: the shutdown handler the
   *  lifecycle host calls is Promise-shaped, so it runs its programs on
   *  this. */
  readonly runtime: ProcessRuntime;
  /** The host's shutdown registry, from the same services: the run's
   *  shutdown-status handler registers here. */
  readonly lifecycle: LifecycleHost;
  /** Forwarded to `runAgent`. Derived by `executeCliConfig` from
   *  `expectedCategory`, never set by a command handler. */
  readonly enforceCategory?: boolean;
  /** Stop a tool-use run after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Workflow output handler extended with the CLI publication gate; attempt
   *  the commit synchronously once before destination validation or I/O. */
  readonly openWorkflowOutput?: CliWorkflowOutputHandler;
  /** Forwarded to `runAgent` on resume, pinning the original handler dialect. */
  readonly modelCompatibilityKey?: RunAgentOptions['modelCompatibilityKey'];
  /** Called during signal shutdown after CANCELLED status is durable and the
   *  resumable checkpoint has been drained, before the signal handler exits. */
  readonly onInterruptedRunFinalized?: (runId: RunId) => void | Promise<void>;
  /** Refine generic flow resumability for the launched workflow's state. */
  readonly canAdvertiseInterruptedRun?: (
    resumability: ResumableCheckpoint,
  ) => boolean;
  /** The agent boundary the request runs through. Composition leaves it
   *  unset and gets the agent runtime's own; a test harness injects its
   *  stand-ins here rather than mocking agent modules. */
  readonly agentRuns?: {
    readonly launch: typeof runAgent;
    readonly finalize: typeof finalizeRun;
    readonly resumability: typeof deriveResumability;
  };
}

type ExecuteAgentResultForCategory<C extends AgentCategory | undefined> =
  C extends AgentCategory
    ? CliRunResult & {
        readonly output: Extract<RunEndOutput, { category: C }>;
      }
    : CliRunResult;

export interface CliConfigExecuteOptions<
  C extends AgentCategory | undefined = undefined,
> extends Omit<CliExecuteOptions, 'enforceCategory'> {
  /** Pins the category this command path must stay in: enforced before the
   *  run by `runAgent`, and the narrowing key for the returned result. */
  readonly expectedCategory?: C;
  /**
   * Resume an existing run under its persisted id instead of minting a
   * fresh one. The CLI turns this into explicit resume intent for `runAgent`.
   */
  readonly runId?: RunId;
}

export type CliConfigExecuteResult<C extends AgentCategory | undefined> =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly outcomePersisted: boolean;
      readonly result: ExecuteAgentResultForCategory<C>;
    }
  | {
      readonly ok: false;
      readonly exitCode: CliExitCode;
    };

/**
 * Build and validate a headless CLI run request, then run it. Command
 * handlers own command-specific config construction; this module owns the
 * common request lifecycle so workflow, tool-use, and multi-agent runs cannot
 * drift on validation, run ids, or category-mismatch status writes.
 */
export function executeCliConfig<
  C extends AgentCategory | undefined = undefined,
>(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions<C>,
): Effect.Effect<CliConfigExecuteResult<C>, Error, CliRunServices> {
  return Effect.gen(function* () {
    const {
      expectedCategory,
      runId: resumedRunId,
      ...executeOptions
    } = options;
    const runId = resumedRunId ?? generateRunId();
    const validation = validateRunRequest({ config, runId });
    if (!validation.valid) {
      writeTextStderr(validation.message);
      return { ok: false as const, exitCode: CliExitCode.Usage };
    }

    const plugins = yield* readCliPluginPins((yield* options.session).roots);
    const request: RunAgentRequest & { readonly runId: RunId } = resumedRunId
      ? { kind: 'resume', ...validation.request, runId }
      : { kind: 'fresh', ...validation.request, runId };
    const run = yield* executeCliRequest(request, runContext, {
      ...executeOptions,
      enforceCategory: expectedCategory !== undefined,
    });
    if (!run.ok) {
      return run;
    }
    const { result } = run;

    if (
      expectedCategory !== undefined &&
      result.output.category !== expectedCategory
    ) {
      // Unreachable: `enforceCategory` above refuses the launch whenever the
      // resolved agent setting disagrees, and the output's category is stamped
      // from that same setting. Kept so the narrowing below stays honest.
      const message = `Agent resolved to a non ${expectedCategory} run.`;
      return yield* Effect.fail(new Error(message));
    }

    return {
      ok: true as const,
      runId,
      outcomePersisted: run.outcomePersisted,
      result: { ...(result as ExecuteAgentResultForCategory<C>), plugins },
    };
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}

export function executeCliToolUseConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions<typeof AgentCategory.ToolUse> & {
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
      expectedCategory: AgentCategory.ToolUse,
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
 * Shared headless-run skeleton for `run` and `multi-agent run`: stand up a
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
  // the session's registry under it (`runs.kill`), which `runAgent` tracks
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
      launch: runAgent,
      finalize: finalizeRun,
      resumability: deriveResumability,
      ...options.agentRuns,
    };
    const session = yield* options.session;
    session.setApprovalPolicy(runContext.approvalPolicy);
    const presentationHost = createCliRuntimeHost(options.runtime, runContext);
    let failurePresented = false;
    const renderWorkflowPlainProgress =
      runContext.outputFormat === 'text' &&
      runContext.renderRunProgress === true;
    const detachRunProgressRenderer =
      presentationHost.attachRunProgressRenderer(session, {
        runId: request.runId,
      });
    const detachHostInteractions = yield* session.interactions.use(
      createHeadlessCliHostInteractions(session, options.runtime, runContext, {
        beforePrompt: () => presentationHost.prepareInteractivePrompt?.(),
        emit: (event, payload) => {
          if (event === 'requestShowError') failurePresented = true;
          presentationHost.emit(event, payload);
        },
      }),
    );
    // Present terminal-error toasts from the run's `result` event through the
    // presentationHost path (so ndjson / logger output is unchanged).
    const detachResultToast = attachTerminalResultToast(
      session,
      session.interactions,
    );
    const terminalResult = trackTerminalResultPresentation(
      session,
      (event) => event.runId === request.runId,
    );
    const detachSessionProgressProjection =
      runContext.outputFormat === 'ndjson'
        ? yield* attachCliSessionProgressProjection(session)
        : Effect.void;
    const detachWorkflowPlainOutput = renderWorkflowPlainProgress
      ? attachWorkflowPlainOutput(options.runtime, session, {
          runId: request.runId,
          beforeWrite: () => presentationHost.prepareInteractivePrompt?.(),
          writeLine: writeTextStderr,
        })
      : () => undefined;
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
        // Both call sites run after runAgent has already published (or failed to
        // publish) the lease, so the plain variable is the settled answer.
        const runId = ownedRunId;
        if (!runId) return false;
        const onFinalized = options.onInterruptedRunFinalized;
        const drain = Effect.gen(function* () {
          const terminalStatusPersisted = (yield* agentRuns.finalize(session, {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            report: reportShutdownFinalizationFailure,
          })).ok;
          yield* session.releaseRunLease(runId);
          const resumability = terminalStatusPersisted
            ? yield* agentRuns.resumability(runId, session)
            : undefined;
          // The lease was released just above, so the checkpoint alone decides
          // whether the recovery notice is usable.
          if (onFinalized !== undefined) {
            const advertise = yield* Effect.try({
              try: () =>
                advertisesInterruptedRun(
                  resumability,
                  options.canAdvertiseInterruptedRun,
                ),
              catch: ensureError,
            });
            if (advertise) {
              yield* Deferred.succeed(recoveryNoticeStarted, undefined);
              yield* Effect.tryPromise({
                try: () => Promise.resolve(onFinalized(runId)),
                catch: ensureError,
              });
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
    const disposeShutdownStatus = options.lifecycle.onShutdown(
      SHUTDOWN_PHASE.BEFORE,
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
            ? session.runs.kill(launchRunId, {
                detachActiveChildren: false,
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
                advertisesInterruptedRun(
                  inspection.success,
                  options.canAdvertiseInterruptedRun,
                );
            }
            // Earlier shutdown handlers interrupt the live agent sessions. Wait
            // for runAgent to finish unwinding before the final drain releases
            // ownership, so no transcript or checkpoint writer can race the
            // lease release. The lifecycle host's phase deadline bounds this
            // wait by interrupting it. Once durable resumability and lease
            // availability have been established, however, keep shutdown alive
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
    const openWorkflowOutput = options.openWorkflowOutput;
    const invoke = (): ReturnType<typeof runAgent> =>
      agentRuns.launch(request, {
        session,
        enforceCategory: options.enforceCategory,
        openWorkflowOutput:
          openWorkflowOutput === undefined
            ? undefined
            : (result, agentDefaultOutputFiles) =>
                openWorkflowOutput(
                  result,
                  agentDefaultOutputFiles,
                  tryCommitWorkflowOutputPublication,
                ),
        modelCompatibilityKey: options.modelCompatibilityKey,
        beforeLeaseRelease: () =>
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
        onRunLeaseAcquired: (runId) => {
          ownedRunId = runId;
        },
        stopAfterCycle: options.stopAfterCycle,
        ...cliToolUseApprovalOptions(session, runContext),
      });

    let runResult:
      | { readonly ok: true; readonly result: ExecuteAgentResult }
      | { readonly ok: false } = { ok: false };
    let primaryRunFailure: { readonly error: unknown } | undefined;
    let shutdownLaunchAborted = false;
    // Run exactly once: the early detach below is taken only on a path that
    // then throws or returns before the success tail that `ensuring`s it.
    const detachPresentation = Effect.gen(function* () {
      detachResultToast();
      terminalResult.dispose();
      detachRunProgressRenderer();
      yield* detachSessionProgressProjection;
      detachWorkflowPlainOutput();
      detachHostInteractions();
      yield* presentationHost.close();
    });
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
      } else if (!(err instanceof AgentError)) {
        primaryRunFailure = { error: err };
      } else if (!failurePresented && !hasErrorPresentationClaimed(err)) {
        // A failure before registration (agent or model resolution) has no
        // `result` event; one after registration is presented by the result
        // toast, which sets `failurePresented`. A launch failure that already
        // presented itself through a targeted notification
        // (model-not-recognized, agent-not-found) is marked claimed at its
        // throw site -- this CLI-local flag only tracks `requestShowError`, so
        // it would otherwise re-surface that failure a second time here.
        const unhandled = terminalResult.reportUnhandled(() =>
          session.interactions.emit('requestShowError', {
            message: toErrorMessage(err),
          }),
        );
        if (unhandled) yield* unhandled;
      }
    }

    disposeShutdownStatus.dispose();
    const cleanupFailures: unknown[] = [];
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
    if (Result.isFailure(finalization))
      cleanupFailures.push(finalization.failure);
    Deferred.doneUnsafe(shutdownFinalizationDone, Effect.void);
    if (!runResult.ok || Result.isFailure(finalization)) {
      const detachment = yield* Effect.result(detachPresentation);
      if (Result.isFailure(detachment))
        cleanupFailures.push(detachment.failure);
    }
    if (cleanupFailures.length > 0) {
      const cleanupFailure = aggregateError(
        cleanupFailures,
        'CLI run cleanup encountered multiple failures',
      );
      if (primaryRunFailure) {
        throw aggregateError(
          [primaryRunFailure.error, cleanupFailure],
          'CLI run failed and its final artifacts could not be persisted',
        );
      }
      throw cleanupFailure;
    }
    if (primaryRunFailure) throw primaryRunFailure.error;

    if (!runResult.ok) {
      return {
        ok: false as const,
        exitCode: shutdownLaunchAborted
          ? CliExitCode.Interrupted
          : runOutcomeExitCode(RUN_OUTCOME.FAILED),
      };
    }

    return yield* Effect.sync(() => {
      const { outcome, outcomePersisted } = Result.getOrThrow(finalization)!;
      return {
        ok: true as const,
        outcomePersisted,
        result: { ...runResult.result, outcome },
      };
    }).pipe(
      Effect.ensuring(
        detachPresentation.pipe(Effect.mapError(ensureError), Effect.orDie),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}
