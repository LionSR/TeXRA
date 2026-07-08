import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { tryPlatform } from '@platform/platform';
import {
  flushPendingRunTraces,
  getDefaultStreamLogStore,
  StreamSnapshotStore,
} from '@transcript';
import { writeTerminalStatus } from '@agent/storage';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import { runAgent } from '@agent/runtime/runAgent';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { attachSessionProgressEventProjection } from '@agent/runtime/sessionProgressEventProjection';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';
import { generateExecutionId } from '@utils/core';

import { approvalPromptsUnavailable } from './approvalPolicyAvailability';
import {
  createHeadlessCliHostInteractions,
  installCliApprovalHandlers,
} from './approvalAdapter';
import { createCliRuntimeHost, type CliRuntimeHost } from './runtimeHost';
import { CliExitCode } from './exitCodes';
import { writeTextStderr } from './logSinks';
import {
  createCliRunResult,
  readCliTerminalStatus,
  terminalStatusExitCode,
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
      readonly terminalStatus: ExecutionStatus;
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

  const { result, terminalStatus } = await executeCliRequest(
    validation.request,
    runContext,
    executeOptions,
  );

  if (expectedCategory !== undefined && result.category !== expectedCategory) {
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
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
    terminalStatus,
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

  const { result, terminalStatus } = execution;
  return {
    ok: true,
    displayResult: createCliRunResult(result, {
      terminalStatus,
      workingDirectory: runContext.cwd,
    }),
    exitCode: terminalStatusExitCode(terminalStatus, runContext),
  };
}

/**
 * Shared headless-execution skeleton for `run`, `agents run`, and
 * `multi-agent run`: stand up a runtime host, run the request (optionally
 * wrapped), always close the host, and resolve the terminal status.
 * Centralizing this stops the three runners from drifting apart on host
 * lifecycle and status handling, which is how their behavior diverged before.
 */
export async function executeCliRequest(
  request: ValidatedExecutionRequest,
  runContext: CliContext,
  options: CliExecuteOptions = {},
): Promise<{ result: ExecuteAgentResult; terminalStatus: ExecutionStatus }> {
  const baseRuntimeHost = createCliRuntimeHost(runContext);
  const snapshotStore = new StreamSnapshotStore();
  const detachSnapshotEvents = snapshotStore.attachSessionEvents(
    defaultSession().events,
  );
  const runtimeHost = baseRuntimeHost;
  const detachHostInteractions = defaultSession().useHostInteractions(
    createHeadlessCliHostInteractions(runContext, {
      beforePrompt: () => runtimeHost.prepareInteractivePrompt?.(),
    }),
  );
  const interactionHost: CliRuntimeHost = {
    ...runtimeHost,
    interactions: defaultSession().interactions,
  };
  // Present terminal-error toasts from the run's `result` event through the same
  // runtimeHost path the lifecycle used before (so ndjson / logger output is
  // unchanged); the lifecycle no longer emits them directly.
  const detachResultToast = attachTerminalResultToast(
    defaultSession(),
    interactionHost,
  );
  const detachSessionProgressProjection = attachSessionProgressEventProjection(
    defaultSession().events,
    interactionHost,
  );
  const uninstallApprovalHandlers = installCliApprovalHandlers(runContext, {
    beforePrompt: () => runtimeHost.prepareInteractivePrompt?.(),
  });
  const ownedExecutionId = options.registerExecution
    ? request.executionId
    : undefined;
  let shutdownInterrupted = false;
  const disposeShutdownStatus = ownedExecutionId
    ? tryPlatform()?.lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, async () => {
        shutdownInterrupted = true;
        await writeTerminalStatus(
          ownedExecutionId,
          EXECUTION_STATUS.INTERRUPTED,
        );
      })
    : undefined;
  const invoke = (): Promise<ExecuteAgentResult> =>
    runAgent(request, {
      runtimeHost: interactionHost,
      enforceCategory: options.enforceCategory,
      registerExecution: options.registerExecution,
      stopAfterCycle: options.stopAfterCycle,
      approvalPromptsUnavailable: approvalPromptsUnavailable(runContext),
      runtimeUnavailableTools: [
        ...CLI_UNAVAILABLE_TOOLS,
        ...(options.runtimeUnavailableTools ?? []),
      ],
    });

  // Headless runs append to StreamLogStore the same as the interactive TUI
  // (via createRunTrace's transcript recorder), but StreamLogStore.save()/
  // flush() silently no-op until .load() has run once — without this, every
  // headless run's streamLogs are appended in memory and then lost entirely
  // when the process exits. Mirrors runChatTui.tsx's best-effort load. Done
  // last (right before the run starts) so it can't delay the synchronous
  // shutdown-hook registration above.
  const streamLogStore = getDefaultStreamLogStore();
  try {
    await streamLogStore.load();
  } catch {
    // Persistence stays disabled; the run still executes in-memory as before.
  }

  let result: ExecuteAgentResult;
  try {
    result = await (options.wrap ? options.wrap(invoke) : invoke());
  } catch (error) {
    if (options.markErrorOnThrow && request.executionId) {
      await writeTerminalStatus(request.executionId, EXECUTION_STATUS.ERROR);
    }
    throw error;
  } finally {
    disposeShutdownStatus?.dispose();
    // If the run settles while shutdown is in progress, keep the
    // signal-owned interrupted status as the final write.
    if (shutdownInterrupted && ownedExecutionId) {
      await writeTerminalStatus(ownedExecutionId, EXECUTION_STATUS.INTERRUPTED);
    }
    detachResultToast();
    detachSessionProgressProjection();
    detachHostInteractions();
    uninstallApprovalHandlers();
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

  const terminalStatus = await readCliTerminalStatus(result);
  return { result, terminalStatus };
}
