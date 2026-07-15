import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { tryPlatform } from '@platform/platform';
import { flushPendingRunTraces, StreamSnapshotStore } from '@transcript';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import { runAgent } from '@agent/runtime/runAgent';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { AgentError } from '@common/errors';
import { EXECUTION_STATUS, RUN_OUTCOME } from '@shared/schemas';
import { generateExecutionId } from '@utils/core';

import { approvalPromptsUnavailable } from './approvalPolicyAvailability';
import { createHeadlessCliHostInteractions } from './approvalAdapter';
import { finalizeCliExecutionOrThrow } from './executionFinalization';
import { attachCliSessionProgressProjection } from './sessionProgressSubscription';
import { initializeHeadlessTranscriptSession } from './transcriptSession';
import { createCliRuntimeHost, type CliRuntimeHost } from './runtimeHost';
import { CliExitCode } from './exitCodes';
import { writeTextStderr } from './logSinks';
import {
  readCliRunOutcome,
  runOutcomeExitCode,
  type ExecuteAgentResult,
} from './terminalStatus';
import { CLI_UNAVAILABLE_TOOLS } from './unavailableTools';
import type { CliContext } from './cliContext';

export interface CliExecuteOptions {
  /** Forwarded to `runAgent`. */
  readonly enforceCategory?: boolean;
  readonly registerExecution?: boolean;
  /**
   * Mark the execution ERROR before rethrowing. The headless `run` /
   * `multi-agent run` paths own the status they create; `resume` re-runs a
   * stored config and must leave the prior terminal status untouched.
   */
  readonly markErrorOnThrow?: boolean;
  /** Stop a tool-use execution after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Additional tools unavailable in this CLI runtime. */
  readonly runtimeUnavailableTools?: readonly string[];
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
  const { expectedCategory, categoryMismatchMessage, ...executeOptions } =
    options;
  const executionId = generateExecutionId();
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
    await finalizeCliExecutionOrThrow(
      executionId,
      EXECUTION_STATUS.ERROR,
      'delete',
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
    exitCode: runOutcomeExitCode(result.outcome, runContext),
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
  const runtimeHost = createCliRuntimeHost(runContext);
  const snapshotStore = new StreamSnapshotStore();
  const detachSnapshotEvents = snapshotStore.attachSessionEvents(
    session.events,
  );
  const detachRunProgressRenderer = runtimeHost.attachRunProgressRenderer(
    session.events,
  );
  const detachHostInteractions = session.useHostInteractions(
    createHeadlessCliHostInteractions(runContext, {
      beforePrompt: () => runtimeHost.prepareInteractivePrompt?.(),
    }),
  );
  const interactionHost: CliRuntimeHost = {
    ...runtimeHost,
    interactions: session.interactions,
  };
  // Present terminal-error toasts from the run's `result` event through the same
  // runtimeHost path the lifecycle used before (so ndjson / logger output is
  // unchanged); the lifecycle no longer emits them directly.
  const detachResultToast = attachTerminalResultToast(session, interactionHost);
  const detachSessionProgressProjection =
    runContext.outputFormat === 'ndjson'
      ? attachCliSessionProgressProjection(session.events)
      : () => undefined;
  const ownedExecutionId = options.registerExecution
    ? request.executionId
    : undefined;
  let shutdownInterrupted = false;
  let shutdownFinalizationError: unknown;
  const disposeShutdownStatus = ownedExecutionId
    ? tryPlatform()?.lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, async () => {
        shutdownInterrupted = true;
        try {
          await finalizeCliExecutionOrThrow(
            ownedExecutionId,
            EXECUTION_STATUS.INTERRUPTED,
            'preserve',
          );
          shutdownFinalizationError = undefined;
        } catch (error) {
          shutdownFinalizationError = error;
        }
      })
    : undefined;
  const invoke = (): Promise<ExecuteAgentResult> =>
    runAgent(request, {
      runtimeHost: interactionHost,
      session,
      enforceCategory: options.enforceCategory,
      registerExecution: options.registerExecution,
      stopAfterCycle: options.stopAfterCycle,
      approvalPromptsUnavailable: approvalPromptsUnavailable(runContext),
      runtimeUnavailableTools: [
        ...CLI_UNAVAILABLE_TOOLS,
        ...(options.runtimeUnavailableTools ?? []),
      ],
    });

  const streamLogStore = session.transcripts;

  let runResult:
    | { readonly ok: true; readonly result: ExecuteAgentResult }
    | { readonly ok: false } = { ok: false };
  // Distinguishes a failed run from a failure in `options.wrap`'s post-run
  // cleanup: once invoke() has resolved, AgentRunLifecycle has already
  // persisted the run's true terminal status (e.g. COMPLETED), and a later
  // cleanup rejection must not overwrite it with ERROR (#7863).
  let invokeSettledOk = false;
  const trackedInvoke = async (): Promise<ExecuteAgentResult> => {
    const result = await invoke();
    invokeSettledOk = true;
    return result;
  };
  try {
    const result = await (options.wrap
      ? options.wrap(trackedInvoke)
      : trackedInvoke());
    runResult = { ok: true, result };
  } catch (err) {
    if (
      options.markErrorOnThrow &&
      request.executionId &&
      !invokeSettledOk &&
      !(err instanceof AgentError)
    ) {
      await finalizeCliExecutionOrThrow(
        request.executionId,
        EXECUTION_STATUS.ERROR,
        'delete',
      );
    }
    // Only a classified, already-handled AgentError resolves to a non-zero
    // exit code here; anything else (e.g. registerExecution disk I/O,
    // workspaceState.update failures) is unexpected and must keep
    // propagating to bin/texra.ts's crash handler.
    if (!(err instanceof AgentError)) {
      throw err;
    }
  } finally {
    disposeShutdownStatus?.dispose();
    // If the run settles while shutdown is in progress, keep the
    // signal-owned interrupted status as the final write.
    if (shutdownInterrupted && ownedExecutionId) {
      try {
        await finalizeCliExecutionOrThrow(
          ownedExecutionId,
          EXECUTION_STATUS.INTERRUPTED,
          'preserve',
        );
        shutdownFinalizationError = undefined;
      } catch (error) {
        shutdownFinalizationError = error;
      }
    }
    detachResultToast();
    detachRunProgressRenderer();
    detachSessionProgressProjection();
    detachHostInteractions();
    try {
      try {
        flushPendingRunTraces();
      } finally {
        detachSnapshotEvents();
      }
      await Promise.all([streamLogStore.flush(), snapshotStore.flush()]);
    } finally {
      await interactionHost.close();
    }
  }

  if (shutdownFinalizationError !== undefined) {
    throw shutdownFinalizationError;
  }

  if (!runResult.ok) {
    // The message was already presented once via the run's `result` event
    // (attachTerminalResultToast → requestShowError); nothing more to print
    // here. Reuse the same outcome-to-exit-code mapping the non-throw failure path
    // uses below, so approval-denied stays distinct from a generic failure.
    return {
      ok: false,
      exitCode: runOutcomeExitCode(RUN_OUTCOME.FAILED, runContext),
    };
  }

  const outcome = await readCliRunOutcome(runResult.result);
  return { ok: true, result: { ...runResult.result, outcome } };
}
