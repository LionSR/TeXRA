import {
  ExecutionLeaseLostError,
  type OwnedExecutionLeaseScope,
} from '@agent/storage/executionLease';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import { runAgent, type RunAgentOptions } from '@agent/runtime/runAgent';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { AgentError } from '@common/errors';
import { tryPlatform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { RUN_OUTCOME, type ExecutionId, AgentCategory } from '@shared/schemas';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { warnApprovalDenied } from './approval/approvalPrompts';
import { cliApprovalPromptsUnavailable } from './approval/settleApprovals';
import { createHeadlessCliHostInteractions } from './approvalAdapter';
import { finalizeCliExecution } from './executionFinalization';
import { attachCliSessionProgressProjection } from './sessionProgressSubscription';
import { initializeHeadlessTranscriptSession } from './transcriptSession';
import { createCliRuntimeHost } from './cliPresentationHost';
import { CliExitCode } from './exitCodes';
import { writeTextStderr } from './logSinks';
import {
  readCliRunOutcome,
  runOutcomeExitCode,
  type ExecuteAgentResult,
} from './terminalStatus';
import { CLI_UNAVAILABLE_TOOLS } from './unavailableTools';
import { attachWorkflowPlainOutput } from './workflowPlainOutput';
import type { CliContext } from './cliContext';

interface CliExecuteOptions {
  /** Forwarded to `runAgent`. */
  readonly enforceCategory?: boolean;
  readonly registerExecution?: boolean;
  /** Stop a tool-use execution after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Additional tools unavailable in this CLI runtime. */
  readonly runtimeUnavailableTools?: readonly string[];
  readonly openWorkflowOutput?: RunAgentOptions['openWorkflowOutput'];
  /** Forwarded to `runAgent` on resume, pinning the original handler dialect. */
  readonly modelHandlerCompatibilityKey?: RunAgentOptions['modelHandlerCompatibilityKey'];
  /** Wrap the run (e.g. multi-agent preset visibility) without leaking the
   *  runtime-host lifecycle into the caller. */
  readonly wrap?: (
    run: () => Promise<ExecuteAgentResult>,
  ) => Promise<ExecuteAgentResult>;
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
   * fresh one. `runAgent` treats a request that carries an id as a resume and
   * reuses its registered record.
   */
  readonly executionId?: ExecutionId;
}

export type CliConfigExecuteResult<C extends AgentCategory | undefined> =
  | {
      readonly ok: true;
      readonly executionId: string;
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

  const execution = await executeCliRequest(
    validation.request,
    runContext,
    executeOptions,
  );
  if (!execution.ok) {
    return execution;
  }
  const { result } = execution;

  if (expectedCategory !== undefined && result.category !== expectedCategory) {
    await finalizeCliExecution(
      executionId,
      RUN_OUTCOME.FAILED,
      'delete',
      (finalizationError) =>
        writeTextStderr(`Warning: ${toErrorMessage(finalizationError)}`),
    );
    writeTextStderr(
      categoryMismatchMessage ??
        `Agent resolved to a non ${expectedCategory} run.`,
    );
    return { ok: false, exitCode: CliExitCode.AgentError };
  }

  return {
    ok: true,
    executionId,
    result: result as ExecuteAgentResultForCategory<C>,
  };
}

export async function executeCliToolUseConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliConfigExecuteOptions<typeof AgentCategory.ToolUse> = {},
) {
  const execution = await executeCliConfig(config, runContext, {
    ...options,
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
 * `multi-agent run`: stand up a runtime host, run the request (optionally
 * wrapped), always close the host, and resolve the terminal outcome.
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
  request: ValidatedExecutionRequest,
  runContext: CliContext,
  options: CliExecuteOptions = {},
): Promise<
  | { ok: true; result: ExecuteAgentResult }
  | { ok: false; exitCode: CliExitCode }
> {
  // Transcript persistence is a launch prerequisite for every headless run.
  // This executes before runtime-host construction and before runAgent.
  const { session } = await initializeHeadlessTranscriptSession();
  session.setApprovalPolicy(runContext.approvalPolicy);
  const presentationHost = createCliRuntimeHost(runContext);
  const renderWorkflowPlainProgress =
    runContext.outputFormat === 'text' && runContext.renderRunProgress === true;
  const detachRunProgressRenderer = presentationHost.attachRunProgressRenderer(
    session.events,
  );
  const detachHostInteractions = session.useHostInteractions(
    createHeadlessCliHostInteractions(runContext, {
      beforePrompt: () => presentationHost.prepareInteractivePrompt?.(),
      emit: (event, payload) => presentationHost.emit(event, payload),
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
  const ownedExecutionId = options.registerExecution
    ? request.executionId
    : undefined;
  let shutdownInterrupted = false;
  let shutdownFinalizationFailureReported = false;
  const reportFinalizationFailure = (error: unknown): void => {
    session.interactions.emit('requestShowError', {
      message: toErrorMessage(error),
    });
  };
  const reportShutdownFinalizationFailure = (error: Error): void => {
    if (shutdownFinalizationFailureReported) return;
    shutdownFinalizationFailureReported = true;
    reportFinalizationFailure(error);
  };
  let settleLeaseScope: (
    scope: OwnedExecutionLeaseScope | undefined,
  ) => void = () => undefined;
  const leaseScopeReady = new Promise<OwnedExecutionLeaseScope | undefined>(
    (resolve) => {
      settleLeaseScope = resolve;
    },
  );
  let shutdownStatusFinalized: Promise<void> | undefined;
  const finalizeShutdownStatus = (): Promise<void> => {
    if (!shutdownInterrupted || !ownedExecutionId) return Promise.resolve();
    shutdownStatusFinalized ??= (async () => {
      const runWithOwnership = await leaseScopeReady;
      if (!runWithOwnership) return;
      try {
        await runWithOwnership(() =>
          finalizeCliExecution(
            ownedExecutionId,
            RUN_OUTCOME.CANCELLED,
            'preserve',
            reportShutdownFinalizationFailure,
          ),
        );
      } catch (error) {
        if (!(error instanceof ExecutionLeaseLostError)) throw error;
      }
    })();
    return shutdownStatusFinalized;
  };
  const disposeShutdownStatus = ownedExecutionId
    ? tryPlatform()?.lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, async () => {
        shutdownInterrupted = true;
        await finalizeShutdownStatus();
      })
    : undefined;
  const invoke = async (): Promise<ExecuteAgentResult> => {
    try {
      return await runAgent(request, {
        session,
        enforceCategory: options.enforceCategory,
        registerExecution: options.registerExecution,
        openWorkflowOutput: options.openWorkflowOutput,
        modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
        beforeLeaseRelease: finalizeShutdownStatus,
        onExecutionLeaseAcquired: (runWithOwnership) => {
          settleLeaseScope(runWithOwnership);
        },
        stopAfterCycle: options.stopAfterCycle,
        approvalPromptsUnavailable: cliApprovalPromptsUnavailable(
          runContext,
          runContext.approvalPolicy,
        ),
        onApprovalPolicyDenial: () =>
          warnApprovalDenied(runContext, 'Tool or edit approval'),
        runtimeUnavailableTools: [
          ...CLI_UNAVAILABLE_TOOLS,
          ...(options.runtimeUnavailableTools ?? []),
        ],
      });
    } finally {
      // Unblock an in-flight shutdown when acquisition failed before a scope
      // became available. Promise resolution is one-shot after success.
      settleLeaseScope(undefined);
    }
  };

  let runResult:
    | { readonly ok: true; readonly result: ExecuteAgentResult }
    | { readonly ok: false } = { ok: false };
  let presentationAttached = true;
  const detachPresentation = async (): Promise<void> => {
    if (!presentationAttached) return;
    presentationAttached = false;
    detachResultToast();
    detachRunProgressRenderer();
    detachSessionProgressProjection();
    detachWorkflowPlainOutput();
    detachHostInteractions();
    await presentationHost.close();
  };
  try {
    const result = await (options.wrap ? options.wrap(invoke) : invoke());
    runResult = { ok: true, result };
  } catch (err) {
    // Only a classified, already-handled AgentError resolves to a non-zero
    // exit code here; anything else (e.g. registerExecution disk I/O,
    // workspaceState.update failures) is unexpected and must keep
    // propagating to bin/texra.ts's crash handler.
    if (!(err instanceof AgentError)) {
      throw err;
    }
  } finally {
    disposeShutdownStatus?.dispose();
    let finalizationCompleted = false;
    try {
      await finalizeShutdownStatus();
      await session.flushArtifacts();
      finalizationCompleted = true;
    } finally {
      if (!runResult.ok || !finalizationCompleted) {
        await detachPresentation();
      }
    }
  }

  if (!runResult.ok) {
    // The message was already presented once via the run's `result` event
    // (attachTerminalResultToast → requestShowError); nothing more to print
    // here. Reuse the same outcome-to-exit-code mapping the non-throw failure path
    // uses below, so approval-denied stays distinct from a generic failure.
    return {
      ok: false,
      exitCode: runOutcomeExitCode(RUN_OUTCOME.FAILED),
    };
  }

  try {
    const outcome = await readCliRunOutcome(
      runResult.result,
      reportFinalizationFailure,
    );
    return { ok: true, result: { ...runResult.result, outcome } };
  } finally {
    await detachPresentation();
  }
}
