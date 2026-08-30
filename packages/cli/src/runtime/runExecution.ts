import pDefer from 'p-defer';
import {
  attachTerminalResultToast,
  runAgent,
  trackTerminalResultPresentation,
  type AgentConfigPayload,
  type RunAgentOptions,
  type RunAgentRequest,
} from '@agent/runtime';
import {
  deriveResumability,
  ExecutionLeaseLostError,
  type ResumabilityDecision,
  finalizeRun,
  retainFlowRecordUnlessCompleted,
} from '@agent/storage';
import { validateExecutionRequest } from '@agent/core/state/executionRequests';
import { AgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import { platform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { RUN_OUTCOME, type ExecutionId, AgentCategory } from '@shared/schemas';
import { getDefaultUnavailableToolNames } from '@tools/registry';
import { aggregateError, generateExecutionId, onAbort } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { warnApprovalDenied } from './approval/approvalPrompts';
import { cliApprovalPromptsUnavailable } from './approval/settleApprovals';
import { createHeadlessCliHostInteractions } from './approvalAdapter';
import {
  formatInterruptedResumeHint,
  tryReadCliCwd,
  writeInterruptedResumeHint,
} from './interruptedResumeHint';
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
import { attachWorkflowPlainOutput } from './workflowPlainOutput';
import type { CliContext } from './cliContext';

type RunAgentWorkflowOutput = NonNullable<
  RunAgentOptions['openWorkflowOutput']
>;
type CliWorkflowOutputHandler = (
  result: Parameters<RunAgentWorkflowOutput>[0],
  tryCommitPublication: () => boolean,
) => ReturnType<RunAgentWorkflowOutput>;

interface CliExecuteOptions {
  /** Forwarded to `runAgent`. */
  readonly enforceCategory?: boolean;
  /** Stop a tool-use execution after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Workflow output handler extended with the CLI publication gate; attempt
   *  the commit synchronously once before destination validation or I/O. */
  readonly openWorkflowOutput?: CliWorkflowOutputHandler;
  /** Forwarded to `runAgent` on resume, pinning the original handler dialect. */
  readonly modelHandlerCompatibilityKey?: RunAgentOptions['modelHandlerCompatibilityKey'];
  /** Called during signal shutdown after CANCELLED status is durable and the
   *  resumable checkpoint has been drained, before the signal handler exits. */
  readonly onInterruptedExecutionFinalized?: (
    executionId: ExecutionId,
  ) => void | Promise<void>;
  /** Refine generic flow resumability for the launched workflow's state. */
  readonly canAdvertiseInterruptedExecution?: (
    resumability: Extract<ResumabilityDecision, { kind: 'checkpoint' }>,
  ) => boolean;
}

type ExecuteAgentResultForCategory<C extends AgentCategory | undefined> =
  C extends AgentCategory
    ? Extract<ExecuteAgentResult, { category: C }>
    : ExecuteAgentResult;

export interface CliConfigExecuteOptions<
  C extends AgentCategory | undefined = undefined,
> extends CliExecuteOptions {
  /** Defensive post-run guard for command paths that must stay in one category. */
  readonly expectedCategory?: C;
  readonly categoryMismatchMessage?: string;
  /**
   * Resume an existing execution under its persisted id instead of minting a
   * fresh one. The CLI turns this into explicit resume intent for `runAgent`.
   */
  readonly executionId?: ExecutionId;
}

export type CliConfigExecuteResult<C extends AgentCategory | undefined> =
  | {
      readonly ok: true;
      readonly executionId: string;
      readonly outcomePersisted: boolean;
      readonly result: ExecuteAgentResultForCategory<C>;
    }
  | {
      readonly ok: false;
      readonly exitCode: CliExitCode;
    };

/**
 * Build and validate a headless CLI execution request, then run it. Command
 * handlers own command-specific config construction; this module owns the
 * common request lifecycle so workflow, tool-use, and multi-agent runs cannot
 * drift on validation, execution ids, or category-mismatch status writes.
 */
export async function executeCliConfig<
  C extends AgentCategory | undefined = undefined,
>(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions<C> = {},
): Promise<CliConfigExecuteResult<C>> {
  const {
    expectedCategory,
    categoryMismatchMessage,
    executionId: resumedExecutionId,
    ...executeOptions
  } = options;
  const executionId = resumedExecutionId ?? generateExecutionId();
  const validation = validateExecutionRequest({ config, executionId });
  if (!validation.valid) {
    writeTextStderr(validation.message);
    return { ok: false, exitCode: CliExitCode.Usage };
  }

  const request: RunAgentRequest = resumedExecutionId
    ? { kind: 'resume', ...validation.request, executionId }
    : { kind: 'fresh', ...validation.request, executionId };
  const execution = await executeCliRequest(
    request,
    runContext,
    executeOptions,
  );
  if (!execution.ok) {
    return execution;
  }
  const { result } = execution;

  if (expectedCategory !== undefined && result.category !== expectedCategory) {
    await finalizeRun({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      // Reported FAILED, so the run's own checkpoint outlives the mismatch
      // and stays resumable (#11315).
      flowRecord: retainFlowRecordUnlessCompleted(RUN_OUTCOME.FAILED),
      report: (finalizationError) =>
        writeTextStderr(`Warning: ${toErrorMessage(finalizationError)}`),
    });
    writeTextStderr(
      categoryMismatchMessage ??
        `Agent resolved to a non ${expectedCategory} run.`,
    );
    return { ok: false, exitCode: CliExitCode.AgentError };
  }

  return {
    ok: true,
    executionId,
    outcomePersisted: execution.outcomePersisted,
    result: result as ExecuteAgentResultForCategory<C>,
  };
}

export async function executeCliToolUseConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions<typeof AgentCategory.ToolUse> & {
    /** False when invocation-owned temporary inputs will not survive exit. */
    readonly recoveryInputIsDurable?: boolean;
  } = {},
) {
  const { recoveryInputIsDurable = true, ...executeOptions } = options;
  const recoveryProcessCwd = tryReadCliCwd();
  const workingDirectory = config.workingDirectory || runContext.cwd;
  const execution = await executeCliConfig(config, runContext, {
    ...executeOptions,
    onInterruptedExecutionFinalized:
      recoveryInputIsDurable === true
        ? (executeOptions.onInterruptedExecutionFinalized ??
          ((executionId) =>
            writeInterruptedResumeHint(
              formatInterruptedResumeHint(
                runContext,
                executionId,
                'session',
                workingDirectory,
                recoveryProcessCwd,
              ),
              true,
            )))
        : undefined,
    expectedCategory: AgentCategory.ToolUse,
  });
  if (!execution.ok) return execution;

  const { result } = execution;
  return {
    ok: true,
    result: {
      ...result,
      workingDirectory: runContext.cwd,
    },
    exitCode: runOutcomeExitCode(result.outcome),
  };
}

/**
 * Shared headless-execution skeleton for `run`, `agents run`, and
 * `multi-agent run`: stand up a runtime host, run the request, always close
 * the host, and resolve the terminal outcome.
 * Centralizing this stops the three runners from drifting apart on host
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
 * this path; any other rejection (e.g. `registerExecution` disk I/O,
 * `workspaceState.update` failures) is genuinely unexpected and is rethrown
 * so the crash handler still reports it.
 */
export async function executeCliRequest(
  request: RunAgentRequest,
  runContext: CliContext,
  options: CliExecuteOptions = {},
): Promise<
  | {
      ok: true;
      outcomePersisted: boolean;
      result: ExecuteAgentResult;
    }
  | { ok: false; exitCode: CliExitCode }
> {
  // Transcript persistence is a launch prerequisite for every headless run.
  // This executes before runtime-host construction and before runAgent.
  const { session } = await initializeCliTranscriptSession();
  session.setApprovalPolicy(runContext.approvalPolicy);
  const presentationHost = createCliRuntimeHost(runContext);
  let failurePresented = false;
  const renderWorkflowPlainProgress =
    runContext.outputFormat === 'text' && runContext.renderRunProgress === true;
  const detachRunProgressRenderer =
    presentationHost.attachRunProgressRenderer(session);
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
    (event) => event.executionId === request.executionId,
  );
  const detachSessionProgressProjection =
    runContext.outputFormat === 'ndjson'
      ? attachCliSessionProgressProjection(session.events)
      : () => undefined;
  const detachWorkflowPlainOutput = renderWorkflowPlainProgress
    ? attachWorkflowPlainOutput(session.events, {
        beforeWrite: () => presentationHost.prepareInteractivePrompt?.(),
        writeLine: writeTextStderr,
      })
    : () => undefined;
  const launchExecutionId = request.executionId;
  let ownedExecutionId: ExecutionId | undefined;
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
  const leaseAcquired = pDefer<ExecutionId | undefined>();
  const shutdownFinalizationDone = pDefer<void>();
  const recoveryNoticeStarted = pDefer<void>();
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
    shutdownStatusFinalized ??= (async () => {
      const executionId = await leaseAcquired.promise;
      if (!executionId) return false;
      try {
        const terminalStatusPersisted = (
          await finalizeRun({
            executionId,
            outcome: RUN_OUTCOME.CANCELLED,
            flowRecord: 'preserve',
            report: reportShutdownFinalizationFailure,
          })
        ).ok;
        await session.releaseExecutionLease(executionId);
        const resumability = terminalStatusPersisted
          ? await deriveResumability(executionId)
          : undefined;
        // The lease was released just above, so the checkpoint alone decides
        // whether the recovery notice is usable.
        if (
          resumability?.kind === 'checkpoint' &&
          options.onInterruptedExecutionFinalized !== undefined &&
          (options.canAdvertiseInterruptedExecution?.(resumability) ?? true)
        ) {
          recoveryNoticeStarted.resolve();
          await options.onInterruptedExecutionFinalized(executionId);
        }
        return true;
      } catch (error) {
        // Record the original drain failure for the one-shot runtime adapter
        // below, which rethrows it into runAgent's artifact aggregate. This
        // memoized operation itself resolves false so the outer shutdown await
        // cannot rethrow the same error over the primary run failure.
        if (
          !(error instanceof ExecutionLeaseLostError) &&
          launchVerdict.kind === 'interrupted'
        ) {
          launchVerdict.artifactFailure = error;
        }
        return false;
      }
    })();
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
      const interruptionAccepted =
        launchVerdict.kind !== 'published' && launchExecutionId
          ? session.executions.kill(launchExecutionId, {
              detachActiveChildren: false,
            })
          : false;
      if (interruptionAccepted && launchVerdict.kind === 'undecided') {
        launchVerdict = {
          kind: 'interrupted',
          artifactFailure: undefined,
          finalizationFailureReported: false,
        };
      }
      let resumableCheckpoint:
        Extract<ResumabilityDecision, { kind: 'checkpoint' }> | undefined;
      if (launchVerdict.kind === 'interrupted' && ownedExecutionId) {
        try {
          const resumability = await deriveResumability(ownedExecutionId);
          if (resumability.kind === 'checkpoint') {
            resumableCheckpoint = resumability;
          }
        } catch {
          // The ordinary bounded shutdown path below remains authoritative
          // when checkpoint inspection itself is unavailable.
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
        (options.canAdvertiseInterruptedExecution?.(resumableCheckpoint) ??
          true) &&
        options.onInterruptedExecutionFinalized
      ) {
        await shutdownFinalizationDone.promise;
        return;
      }
      const first = await Promise.race([
        shutdownFinalizationDone.promise.then(() => 'finalized' as const),
        new Promise<'deadline'>((resolve) =>
          onAbort(shutdownDeadline, () => resolve('deadline')),
        ),
        ...(options.onInterruptedExecutionFinalized
          ? [
              recoveryNoticeStarted.promise.then(
                () => 'recovery-started' as const,
              ),
            ]
          : []),
      ]);
      if (first === 'recovery-started') {
        await shutdownFinalizationDone.promise;
      }
    },
  );
  const openWorkflowOutput = options.openWorkflowOutput;
  const invoke = async (): Promise<ExecuteAgentResult> => {
    try {
      return await runAgent(request, {
        session,
        enforceCategory: options.enforceCategory,
        openWorkflowOutput:
          openWorkflowOutput === undefined
            ? undefined
            : (result) =>
                openWorkflowOutput(result, tryCommitWorkflowOutputPublication),
        modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
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
        onExecutionLeaseAcquired: (executionId) => {
          ownedExecutionId = executionId;
          leaseAcquired.resolve(executionId);
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
    } finally {
      // Unblock an in-flight shutdown when acquisition failed before a scope
      // became available. Promise resolution is one-shot after success.
      leaseAcquired.resolve(undefined);
    }
  };

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
    detachSessionProgressProjection();
    detachWorkflowPlainOutput();
    detachHostInteractions();
    await presentationHost.close();
  };
  try {
    const result = await invoke();
    runResult = { ok: true, result };
  } catch (err) {
    // Only a classified, already-handled AgentError resolves to a non-zero
    // exit code here; anything else (e.g. registerExecution disk I/O,
    // workspaceState.update failures) is unexpected and must keep
    // propagating to bin/texra.ts's crash handler.
    if (shutdownRequested && isUserAbort(err)) {
      shutdownLaunchAborted = true;
    } else if (!(err instanceof AgentError)) {
      primaryRunFailure = { error: err };
    } else if (!failurePresented && !hasErrorPresentationClaimed(err)) {
      // A failure before lifecycle startup has no `result` event. Preserve the
      // ordinary toast path when it ran, and provide the missing direct fallback
      // while the presentation host is still attached. A launch failure that
      // already presented itself through a targeted notification is marked by
      // the delivery-confirmed throw site (model-not-recognized, and now also
      // agent-not-found because `showAgentConfigBanner` renders a visible CLI
      // error) -- this CLI-local `failurePresented` flag only tracks
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
  try {
    await finalizeShutdownStatus();
    await session.flushArtifacts();
    finalizationCompleted = true;
  } catch (error) {
    cleanupFailures.push(error);
  } finally {
    shutdownFinalizationDone.resolve();
    if (!runResult.ok || !finalizationCompleted) {
      try {
        await detachPresentation();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (cleanupFailures.length > 0) {
    const cleanupFailure = aggregateError(
      cleanupFailures,
      'CLI execution cleanup encountered multiple failures',
    );
    if (primaryRunFailure) {
      throw aggregateError(
        [primaryRunFailure.error, cleanupFailure],
        'CLI execution failed and its final artifacts could not be persisted',
      );
    }
    throw cleanupFailure;
  }
  if (primaryRunFailure) {
    throw primaryRunFailure.error;
  }

  if (!runResult.ok) {
    return {
      ok: false,
      exitCode: shutdownLaunchAborted
        ? CliExitCode.Interrupted
        : runOutcomeExitCode(RUN_OUTCOME.FAILED),
    };
  }

  try {
    const { outcome, outcomePersisted } = await readCliRunOutcomeState(
      runResult.result,
      reportFinalizationFailure,
    );
    return {
      ok: true,
      outcomePersisted,
      result: { ...runResult.result, outcome },
    };
  } finally {
    await detachPresentation();
  }
}
