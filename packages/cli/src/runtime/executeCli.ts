import { Cause, Deferred, Effect, Result } from 'effect';

import {
  attachTerminalResultToast,
  runAgent,
  trackTerminalResultPresentation,
  validateRunRequest,
  type AgentConfigPayload,
  type RunAgentOptions,
  type RunAgentRequest,
} from '@agent/runtime';
import {
  deriveResumability,
  RunLeaseLostError,
  type ResumabilityDecision,
  finalizeRun,
} from '@agent/storage';
import { AgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import { platform } from '@platform/platform';
import { AppState, SHUTDOWN_PHASE } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { Secrets } from '@platform/secrets';
import {
  RUN_OUTCOME,
  type RunEndOutput,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import { getDefaultUnavailableToolNames } from '@tools/registry';
import { aggregateError, generateRunId, onAbort } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { warnApprovalDenied } from './approval/approvalPrompts';
import { cliApprovalPromptsUnavailable } from './approval/settleApprovals';
import { createHeadlessCliHostInteractions } from './approvalAdapter';
import {
  formatInterruptedResumeHint,
  tryReadCliCwd,
  writeInterruptedResumeHint,
} from './interruptedResumeHint';
import { attachWorkflowPlainOutput } from './runProgressRenderer';
import { attachCliSessionProgressProjection } from './sessionProgressSubscription';
import { initializeCliTranscriptSession } from './transcriptSession';
import { createCliRuntimeHost } from './cliPresentationHost';
import { CliExitCode } from './exitCodes';
import { writeTextStderr } from './logSinks';
import {
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
  tryCommitPublication: () => boolean,
) => Effect.Effect<Awaited<ReturnType<RunAgentWorkflowOutput>>, Error>;

interface CliExecuteOptions {
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
    resumability: Extract<ResumabilityDecision, { kind: 'checkpoint' }>,
  ) => boolean;
}

type ExecuteAgentResultForCategory<C extends AgentCategory | undefined> =
  C extends AgentCategory
    ? ExecuteAgentResult & {
        readonly output: Extract<RunEndOutput, { category: C }>;
      }
    : ExecuteAgentResult;

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
  options: CliConfigExecuteOptions<C> = {},
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

    const request: RunAgentRequest = resumedRunId
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
      // Unreachable: `enforceCategory` above makes the launch throw before the
      // run whenever the resolved agent setting disagrees, and the output's
      // category is stamped from that same resolved setting. Kept as an invariant so the
      // `ExecuteAgentResultForCategory<C>` narrowing below stays honest.
      throw new Error(`Agent resolved to a non ${expectedCategory} run.`);
    }

    return {
      ok: true as const,
      runId,
      outcomePersisted: run.outcomePersisted,
      result: result as ExecuteAgentResultForCategory<C>,
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
  } = {},
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
 * second time alongside a "please report it" line (issue #7645). Flows' own
 * rethrow stays untouched; only this CLI boundary stops propagating it
 * further. Only `AgentError` — the classified, already-handled shape — takes
 * this path; any other rejection (e.g. `registerRun` disk I/O,
 * `workspaceState.update` failures) is genuinely unexpected and is rethrown
 * so the crash handler still reports it.
 */
export function executeCliRequest(
  request: RunAgentRequest,
  runContext: CliContext,
  options: CliExecuteOptions = {},
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
    // Transcript persistence is a launch prerequisite for every headless run.
    // This executes before runtime-host construction and before runAgent.
    const stores = { secrets: yield* Secrets, globalState: yield* AppState };
    const session = yield* Effect.tryPromise({
      try: () => initializeCliTranscriptSession(stores),
      catch: ensureError,
    });
    session.setApprovalPolicy(runContext.approvalPolicy);
    const presentationHost = createCliRuntimeHost(runContext);
    let failurePresented = false;
    const renderWorkflowPlainProgress =
      runContext.outputFormat === 'text' &&
      runContext.renderRunProgress === true;
    const detachRunProgressRenderer =
      presentationHost.attachRunProgressRenderer(session, {
        runId: request.runId,
      });
    const detachHostInteractions = session.interactions.use(
      createHeadlessCliHostInteractions(runContext, {
        beforePrompt: () => presentationHost.prepareInteractivePrompt?.(),
        emit: (event, payload) => {
          if (event === 'requestShowError') failurePresented = true;
          return presentationHost.emit(event, payload);
        },
        setApprovalBypassState: (update) =>
          presentationHost.emitApprovalBypassState(update),
      }),
    );
    // Present terminal-error toasts from the run's `result` event through the same
    // presentationHost path the lifecycle used before (so ndjson / logger output is
    // unchanged); the lifecycle no longer emits them directly.
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
        ? attachCliSessionProgressProjection(session)
        : async () => undefined;
    const detachWorkflowPlainOutput = renderWorkflowPlainProgress
      ? attachWorkflowPlainOutput(session, {
          runId: request.runId,
          beforeWrite: () => presentationHost.prepareInteractivePrompt?.(),
          writeLine: writeTextStderr,
        })
      : () => undefined;
    const launchRunId = request.runId;
    let ownedRunId: RunId | undefined;
    // Feeds `runAgent`'s `launchSignal` option: the agent runtime's launch
    // contract is still AbortSignal-native, so the launch-cancellation signal
    // stays until that lane migrates it to fiber interruption (PRD R5 adapts
    // signals only at such edges).
    const launchAbortController = new AbortController();
    let shutdownRequested = false;
    // Workflow-output publication and shutdown-driven interruption race on the
    // same synchronous tick (see tryCommitWorkflowOutputPublication and the
    // onShutdown handler below): at most one may own the terminal verdict for
    // this launch. Modeling that as one variable makes "both committed and
    // interrupted" unrepresentable instead of relying on two booleans staying
    // in sync by hand. The artifact-failure and report-dedupe bookkeeping are
    // only ever meaningful once interrupted, so they live on that variant too.
    type LaunchVerdict =
      | { readonly kind: 'undecided' }
      | { readonly kind: 'published' }
      | {
          readonly kind: 'interrupted';
          artifactFailure: unknown;
          finalizationFailureReported: boolean;
        };
    let launchVerdict: LaunchVerdict = { kind: 'undecided' };
    const reportFinalizationFailure = (error: unknown): void => {
      session.interactions.emit('requestShowError', {
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
    let shutdownStatusFinalized: Promise<boolean> | undefined;
    // Both callbacks enter on this event loop, and neither yields between the
    // check and assignment. Exactly one can therefore own the terminal verdict.
    const tryCommitWorkflowOutputPublication = (): boolean => {
      if (launchVerdict.kind === 'interrupted') return false;
      launchVerdict = { kind: 'published' };
      return true;
    };
    const finalizeShutdownStatus = (): Promise<boolean> => {
      if (launchVerdict.kind !== 'interrupted') return Promise.resolve(false);
      shutdownStatusFinalized ??= effectRuntime().runPromise(
        Effect.gen(function* () {
          // Both call sites run after runAgent has already published (or failed to
          // publish) the lease, so the plain variable is the settled answer.
          const runId = ownedRunId;
          if (!runId) return false;
          const onFinalized = options.onInterruptedRunFinalized;
          const drain = Effect.gen(function* () {
            const terminalStatusPersisted = (yield* finalizeRun(session, {
              runId,
              outcome: RUN_OUTCOME.CANCELLED,
              report: reportShutdownFinalizationFailure,
            })).ok;
            yield* session.releaseRunLease(runId);
            const resumability = terminalStatusPersisted
              ? yield* deriveResumability(runId, session)
              : undefined;
            // The lease was released just above, so the checkpoint alone decides
            // whether the recovery notice is usable.
            if (
              resumability?.kind === 'checkpoint' &&
              onFinalized !== undefined
            ) {
              const advertise = yield* Effect.try({
                try: () =>
                  options.canAdvertiseInterruptedRun?.(resumability) ?? true,
                catch: (error: unknown) => error,
              });
              if (advertise) {
                yield* Deferred.succeed(recoveryNoticeStarted, undefined);
                yield* Effect.tryPromise({
                  try: () => Promise.resolve(onFinalized(runId)),
                  catch: (error: unknown) => error,
                });
              }
            }
            return true;
          });
          // Record the original drain failure for the one-shot runtime adapter
          // below, which rethrows it into runAgent's artifact aggregate. This
          // memoized operation itself resolves false so the outer shutdown await
          // cannot rethrow the same error over the primary run failure. A lease
          // loss is the expected shutdown contention, not a drain failure.
          return yield* drain.pipe(
            Effect.catch((error: unknown) =>
              Effect.sync(() => {
                if (
                  !(error instanceof RunLeaseLostError) &&
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
      return shutdownStatusFinalized;
    };
    const disposeShutdownStatus = platform().lifecycle.onShutdown(
      SHUTDOWN_PHASE.BEFORE,
      async (shutdownDeadline) => {
        shutdownRequested = true;
        launchAbortController.abort();
        // Paired with tryCommitWorkflowOutputPublication: keep this read of
        // launchVerdict and the assignment below in one synchronous turn.
        // Headless shutdown deliberately cascades into active children: a
        // detached child cannot outlive the exiting CLI process, so the
        // detach-on-stop toggle is not consulted on this path.
        const stop =
          launchVerdict.kind !== 'published' && launchRunId
            ? session.runs.kill(launchRunId, {
                detachActiveChildren: false,
              })
            : undefined;
        if (stop?.accepted && launchVerdict.kind === 'undecided') {
          launchVerdict = {
            kind: 'interrupted',
            artifactFailure: undefined,
            finalizationFailureReported: false,
          };
        }
        const interruptedRunId =
          launchVerdict.kind === 'interrupted' ? ownedRunId : undefined;
        if (stop) await effectRuntime().runPromise(stop.settlement);
        let resumableCheckpoint:
          Extract<ResumabilityDecision, { kind: 'checkpoint' }> | undefined;
        if (interruptedRunId) {
          const runId = interruptedRunId;
          const inspection = await effectRuntime().runPromise(
            Effect.result(deriveResumability(runId, session)),
          );
          // The ordinary bounded shutdown path below remains authoritative when
          // checkpoint inspection itself is unavailable.
          if (
            Result.isSuccess(inspection) &&
            inspection.success.kind === 'checkpoint'
          ) {
            resumableCheckpoint = inspection.success;
          }
        }
        // Earlier shutdown handlers interrupt the live agent sessions. Wait for
        // runAgent to finish unwinding before the final drain releases ownership,
        // so no transcript or checkpoint writer can race the lease release.
        // A provider or filesystem operation outside our abortable boundaries
        // must not prevent termination indefinitely before recovery is known to
        // be possible: the lifecycle host's phase deadline (`shutdownDeadline`)
        // bounds this wait. Once durable resumability and lease availability
        // have been established, however, keep shutdown alive until the promised
        // recovery notice has been flushed.
        if (
          resumableCheckpoint &&
          (options.canAdvertiseInterruptedRun?.(resumableCheckpoint) ?? true) &&
          options.onInterruptedRunFinalized
        ) {
          await effectRuntime().runPromise(
            Deferred.await(shutdownFinalizationDone),
          );
          return;
        }
        const first = await effectRuntime().runPromise(
          Effect.raceAll([
            Deferred.await(shutdownFinalizationDone).pipe(
              Effect.as('finalized' as const),
            ),
            Effect.callback<'deadline'>((resume) => {
              const detach = onAbort(shutdownDeadline, () =>
                resume(Effect.succeed('deadline' as const)),
              );
              return Effect.sync(detach);
            }),
            ...(options.onInterruptedRunFinalized
              ? [
                  Deferred.await(recoveryNoticeStarted).pipe(
                    Effect.as('recovery-started' as const),
                  ),
                ]
              : []),
          ]),
        );
        if (first === 'recovery-started') {
          await effectRuntime().runPromise(
            Deferred.await(shutdownFinalizationDone),
          );
        }
      },
    );
    const openWorkflowOutput = options.openWorkflowOutput;
    const invoke = (): ReturnType<typeof runAgent> =>
      runAgent(request, {
        session,
        enforceCategory: options.enforceCategory,
        openWorkflowOutput:
          openWorkflowOutput === undefined
            ? undefined
            : (result) =>
                effectRuntime().runPromise(
                  openWorkflowOutput(
                    result,
                    tryCommitWorkflowOutputPublication,
                  ),
                ),
        modelCompatibilityKey: options.modelCompatibilityKey,
        launchSignal: launchAbortController.signal,
        beforeLeaseRelease: async () => {
          const handled = await finalizeShutdownStatus();
          if (
            launchVerdict.kind === 'interrupted' &&
            launchVerdict.artifactFailure !== undefined
          ) {
            const error = launchVerdict.artifactFailure;
            launchVerdict.artifactFailure = undefined;
            throw error;
          }
          return handled;
        },
        onRunLeaseAcquired: (runId) => {
          ownedRunId = runId;
        },
        stopAfterCycle: options.stopAfterCycle,
        approvalPromptsUnavailable: cliApprovalPromptsUnavailable(
          runContext,
          runContext.approvalPolicy,
        ),
        onApprovalPolicyDenial: () =>
          warnApprovalDenied(runContext, 'Tool or edit approval'),
        runtimeUnavailableTools: getDefaultUnavailableToolNames('cli'),
      });

    let runResult:
      | { readonly ok: true; readonly result: ExecuteAgentResult }
      | { readonly ok: false } = { ok: false };
    let primaryRunFailure: { readonly error: unknown } | undefined;
    let shutdownLaunchAborted = false;
    let presentationAttached = true;
    const detachPresentation = async (): Promise<void> => {
      if (!presentationAttached) return;
      presentationAttached = false;
      detachResultToast();
      terminalResult.dispose();
      detachRunProgressRenderer();
      await detachSessionProgressProjection();
      detachWorkflowPlainOutput();
      detachHostInteractions();
      await presentationHost.close();
    };
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
        // toast, which sets `failurePresented`. Provide the direct fallback
        // while the presentation host is still attached. A launch failure that
        // already presented itself through a targeted notification
        // (model-not-recognized, agent-not-found) is marked claimed at its
        // throw site -- this CLI-local `failurePresented` flag only tracks
        // `requestShowError`, so it would otherwise re-surface that failure a
        // second time here.
        terminalResult.reportUnhandled(() =>
          session.interactions.emit('requestShowError', {
            message: toErrorMessage(err),
          }),
        );
      }
    }

    disposeShutdownStatus.dispose();
    let finalizationCompleted = false;
    const cleanupFailures: unknown[] = [];
    const finalization = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await finalizeShutdownStatus();
            await session.flushArtifacts();
          },
          catch: (error: unknown) => error,
        });
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
    finalizationCompleted = Result.isSuccess(finalization);
    if (Result.isFailure(finalization))
      cleanupFailures.push(finalization.failure);
    Deferred.doneUnsafe(shutdownFinalizationDone, Effect.void);
    if (!runResult.ok || !finalizationCompleted) {
      const detachment = yield* Effect.result(
        Effect.tryPromise({
          try: detachPresentation,
          catch: (error: unknown) => error,
        }),
      );
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
    if (primaryRunFailure) {
      throw primaryRunFailure.error;
    }

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
        Effect.tryPromise({ try: detachPresentation, catch: ensureError }).pipe(
          Effect.orDie,
        ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}
