/**
 * Subagent execution and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue. One-shot/headless parent runs execute subagents in-band because there
 * is no later interactive follow-up turn to consume async delivery.
 */

// Local imports - agent
import {
  getExecutionStore,
  registerExecution,
  type ResultMeta,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { evaluateCurrentDelegationGate } from '@agent/runtime/delegationPolicy';
import { currentSession } from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import {
  getAgentFlowErrorResult,
  type AgentFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import {
  enableYoloOnChildStream,
  inheritBashBypassOnChildStream,
} from '@tools/approval';
import {
  computeAndWriteWorkflowDiffs,
  type DiffFileInfo,
} from '@tools/subagentDiffs';
import {
  buildSubagentFailureResultMeta,
  buildSubagentResultMeta,
  formatSubagentDelivery,
  formatSubagentError,
  formatSubagentProgress,
} from '@tools/subagentResults';
import {
  SUBAGENT_DELIVERY_DECISION,
  subagentDeliveryRegistry,
} from '@tools/subagentDeliveryState';
import {
  deliverChildRunFollowUp,
  persistChildRunReport,
} from '@tools/childRunDelivery';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - utils
import { generateExecutionId } from '@utils/core/executionId';

// ============================================================================
// Shared utilities
// ============================================================================

const LOG_CHANNEL = 'delegation';
logger.initialize(LOG_CHANNEL);

/** Metadata about how the delegation was approved, included in the tool result. */
interface ApprovalMeta {
  autoApproved: boolean;
  modelOverride?: string;
  requestedModel?: string;
  agentOverride?: string;
  requestedAgent?: string;
}

/**
 * Format a subagent result for delivery to the orchestrator.
 * For workflow results, computes latexdiffs and writes them as files to the
 * execution's run directory first — the delivery references diff file paths
 * so the orchestrator can read them on demand via /executions/{id}/files/.
 */
async function subagentDeliveryMessage(
  executionId: string,
  agentName: string,
  result: AgentFlowResult,
  options: {
    readonly startedAt: number;
    readonly workingDirectory?: string;
  },
): Promise<{ msg: string; resultMeta: ResultMeta }> {
  let diffInfos: Map<string, DiffFileInfo> | undefined;
  let diffsUnavailable: string | undefined;
  if (result.category === 'workflow' && result.outputs.length > 0) {
    try {
      diffInfos = await computeAndWriteWorkflowDiffs(
        executionId,
        result.outputs,
      );
    } catch (err) {
      // Diff computation failure is non-fatal — deliver without diffs, but
      // tell the orchestrator so it can read the output files directly
      // instead of assuming the revision was a no-op.
      diffsUnavailable = toErrorMessage(err);
      logger.warn(
        'subagentDelivery',
        `Diff computation failed for ${executionId}: ${diffsUnavailable}`,
      );
    }
  }

  const wallTimeMs = Date.now() - options.startedAt;
  return {
    msg: formatSubagentDelivery(agentName, result, {
      diffInfos,
      diffsUnavailable,
      wallTimeMs,
      workingDirectory: options.workingDirectory,
    }),
    resultMeta: buildSubagentResultMeta(agentName, result, {
      diffInfos,
      diffsUnavailable,
      wallTimeMs,
    }),
  };
}

async function writeSubagentReport(
  executionId: string,
  message: string,
): Promise<void> {
  const result = await persistChildRunReport(
    executionId as ExecutionId,
    message,
  );
  if (result.kind === 'failed') {
    // Non-fatal, but the report is the only durable copy of the result when
    // delivery later fails — leave a trace instead of vanishing silently.
    logger.warn(
      'subagentDelivery',
      `Failed to persist subagent report for ${executionId}: ${toErrorMessage(result.err)}`,
    );
  }
}

/**
 * Best-effort persist of the structured result manifest — the chaining
 * contract read via /executions/{id}/result. Never blocks or fails
 * delivery.
 */
async function writeSubagentResultMeta(
  executionId: string,
  resultMeta: ResultMeta,
): Promise<void> {
  try {
    await getExecutionStore(executionId).writeResultMeta(resultMeta);
  } catch (err) {
    logger.warn(
      'subagentDelivery',
      `Failed to persist subagent result manifest for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Runtime depth gate shared by fresh delegations and resumes.
 * Evaluates against the current workspace delegation policy.
 */
export function depthGateError(
  parentDelegationDepth: number,
): ToolResult | null {
  const gate = evaluateCurrentDelegationGate(parentDelegationDepth);
  if (gate.allowed) return null;

  const unknownDepth = gate.blockReason === 'unknown_depth';
  const reason = unknownDepth
    ? [
        'The current session was resumed from saved state,',
        'but its delegation lineage could not be verified.',
      ].join(' ')
    : [
        `This agent is already at delegation depth ${gate.depth},`,
        'and agents may delegate only when their current depth is less than',
        'the configured max depth.',
      ].join(' ');
  const remediation = unknownDepth
    ? [
        'Resume or restart from a valid parent session,',
        'or complete this task directly without delegating.',
      ].join(' ')
    : [
        'Raise Settings → Multi-Agent → Max delegation depth,',
        'or complete this task directly without delegating.',
      ].join(' ');
  return {
    status: 'error',
    error: [
      `Delegation depth cap reached (current depth ${gate.depth},`,
      `max depth ${gate.maxDepth}).`,
      reason,
      remediation,
    ].join(' '),
    diagnostics: {
      type: 'delegation_depth_cap',
      currentDepth: gate.depth,
      currentDepthKnown: !unknownDepth,
      maxDepth: gate.maxDepth,
      blockReason: gate.blockReason,
    },
  };
}

/**
 * Execute a subagent asynchronously.
 * Pre-generates executionId so all IDs (tool return, XML delivery, error)
 * are consistent and usable with the executions tool.
 *
 * Result is delivered via FollowUpQueue. For tool-use subagents, the result
 * is delivered early via onBeforeWaiting (before the subagent enters WAITING),
 * so the orchestrator gets the response without waiting for flow exit.
 * For workflow subagents, delivery happens when the promise resolves.
 */
export async function executeSubagent(
  configPayload: AgentConfigPayload,
  agentName: string,
  orchestratorStreamId: StreamTabId,
  options?: { enableYoloOnChild?: boolean; approvalMeta?: ApprovalMeta },
): Promise<ToolResult> {
  // Lazy import: the delegation tool runs agents, and the agent runtime loads
  // this tool through the registry. Same intentional recursion pattern as the
  // dynamic RemoteAgentLoader import in agentRegistry.
  const { executeAgent } = await import('@agent/runtime/executeAgent');
  const parentContext = tryUseRunContext();
  if (!parentContext?.runtimeHost) {
    return {
      status: 'error',
      summary: 'Delegation tool runtime host unavailable',
      error:
        'delegate_agent and delegate_workflow require an active tool runtime host. Run delegation from an active agent session, or ensure the tool run context provides runtimeHost.',
      diagnostics: {
        type: 'missing_runtime_host',
        tools: ['delegate_agent', 'delegate_workflow'],
      },
    };
  }
  const parentExecutionId = parentContext.executionId;
  const parentDelegationDepth = parentContext.delegationDepth ?? 0;
  const runtimeHost = parentContext.runtimeHost;
  const parentSession = currentSession();
  // Captured now (while the launching tool call's ALS frame is live) so the
  // async completion callbacks below can still roll the child's cost into the
  // parent run after this tool call has returned. Subagents count toward
  // parent usage totals only — they never drive the loop.
  const recordSubagentCost = getCurrentToolCallContext()?.recordSubagentCost;
  let subagentCostSettled = false;
  function settleSubagentCost(result?: AgentFlowResult): void {
    if (subagentCostSettled) return;
    subagentCostSettled = true;
    recordSubagentCost?.(result?.totalCostUsd ?? 0);
  }

  const gated = depthGateError(parentDelegationDepth);
  if (gated) return gated;

  const executionId = generateExecutionId();
  const startedAt = Date.now();
  const workingDirectory = configPayload.workingDirectory ?? undefined;

  const syntheticConfig = AgentConfigSchema.parse(configPayload);
  await registerExecution(
    executionId,
    syntheticConfig,
    agentName,
    parentExecutionId,
    undefined,
    parentDelegationDepth + 1,
  );

  const inheritChildStreamApprovals = (resolvedStreamId: StreamTabId): void => {
    // Bash bypass follows the parent regardless of edit-YOLO, so a bash-only
    // parent (CLI AUTO-BASH without AUTO-APPROVE) still propagates to the child.
    inheritBashBypassOnChildStream(resolvedStreamId, orchestratorStreamId);
    if (options?.enableYoloOnChild) {
      enableYoloOnChildStream(resolvedStreamId);
    }
  };

  if (parentContext.stopAfterCycle) {
    const failureResult = async (
      err: unknown,
      result?: AgentFlowResult,
    ): Promise<ToolResult> => {
      const wallTimeMs = Date.now() - startedAt;
      const msg = formatSubagentError(executionId, agentName, err, {
        wallTimeMs,
        workingDirectory,
        memoryMisses: result?.memoryMisses,
      });
      await Promise.all([
        writeSubagentReport(executionId, msg),
        writeSubagentResultMeta(
          executionId,
          // Keep the failed run's data (partial outputs, category, cost)
          // in the manifest, matching the async error path.
          buildSubagentFailureResultMeta(agentName, result, wallTimeMs),
        ),
      ]);
      return {
        status: 'error',
        summary: `Subagent '${agentName}' failed`,
        error: toErrorMessage(err),
      };
    };
    try {
      let subagentError: unknown;
      const result = await executeAgent(configPayload, executionId, {
        runtimeHost,
        isSubagent: true,
        enforceCategory: true,
        parentStreamId: orchestratorStreamId,
        delegationDepth: parentDelegationDepth + 1,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        toolEditApprovalHandler: parentContext.toolEditApprovalHandler,
        stopAfterCycle: true,
        onStreamResolved: inheritChildStreamApprovals,
        onError: (err) => {
          subagentError = err;
        },
      });
      settleSubagentCost(result);
      if (result.outcome === 'failed') {
        return failureResult(
          subagentError ?? 'Subagent ended with failed outcome.',
          result,
        );
      }
      const { msg, resultMeta } = await subagentDeliveryMessage(
        executionId,
        agentName,
        result,
        { startedAt, workingDirectory },
      );
      await Promise.all([
        writeSubagentReport(executionId, msg),
        writeSubagentResultMeta(executionId, resultMeta),
      ]);
      return {
        status: 'executed',
        summary:
          result.outcome === 'cancelled'
            ? `Cancelled '${agentName}'`
            : `Completed '${agentName}'`,
        output: msg,
      };
    } catch (err) {
      // AgentFlowError carries the failed run's result — keep its category,
      // partial outputs, and cost in the failure manifest for chaining.
      const errorResult = getAgentFlowErrorResult(err);
      settleSubagentCost(errorResult);
      return failureResult(err, errorResult);
    }
  }

  // Register delivery state so delegate_agent (resume) can find live subagents.
  // The state object owns duplicate-delivery protection between onBeforeWaiting
  // and onCompleted. When a follow-up is consumed, the next onBeforeWaiting
  // delivers the resumed cycle's result.
  const deliveryState = subagentDeliveryRegistry.start(executionId);
  let childStreamId: StreamTabId | undefined;

  /**
   * Deliver a follow-up to the parent stream. For terminal results (`wake`),
   * a parent whose cycle has exited is resumed via the host port so the
   * queued result is consumed instead of sitting until the user pokes the
   * stream; if the parent is gone for good (terminal status, resume failed),
   * the force-reopened queue is re-released so late deliveries don't leak
   * into the next run — the result stays readable in the execution report.
   */
  async function deliverFollowUp(
    followUp: FollowUpQueueInput,
    options?: { wake?: boolean },
  ): Promise<boolean> {
    const handle = currentSession().executions.getHandle(executionId);
    const targetStreamId =
      handle instanceof AgentExecutionHandle
        ? handle.deliveryTargetStreamId
        : orchestratorStreamId;
    if (!targetStreamId) return false;

    const result = await deliverChildRunFollowUp({
      targetStreamId,
      followUp,
      session: parentSession,
      wake: options?.wake,
    });
    if (result.kind === 'no_session') {
      logger.warn(
        'subagentDelivery',
        `Unable to deliver subagent result for ${executionId}: parent stream ${targetStreamId} has no active session (status: ${result.streamStatus ?? 'unknown'}).`,
      );
      return false;
    }
    if (result.kind === 'dropped') {
      logger.warn(
        'subagentDelivery',
        `Dropped subagent result for ${executionId}: parent stream ${targetStreamId} is gone and could not be resumed. The result remains in the execution report.`,
      );
      return false;
    }
    return true;
  }

  async function deliverTerminalFollowUp(
    followUp: FollowUpQueueInput,
  ): Promise<boolean> {
    if (!deliveryState.beginDelivery()) return false;
    try {
      const delivered = await deliverFollowUp(followUp, { wake: true });
      if (delivered) {
        deliveryState.completeDelivery();
      } else {
        deliveryState.failDelivery();
      }
      return delivered;
    } catch (err) {
      deliveryState.failDelivery();
      throw err;
    }
  }

  /**
   * Deliver a terminal result and persist its report (and, when available,
   * its structured result manifest) concurrently — the best-effort writes
   * never delay the parent's wakeup, and they run even when delivery is
   * deduplicated (the report/manifest are the durable copies).
   */
  async function persistAndDeliverTerminal(
    msg: string,
    resultMeta?: ResultMeta,
  ): Promise<boolean> {
    // The manifest lands BEFORE the wake: a parent chaining on this result
    // reads /executions/{id}/result the moment the follow-up arrives, so
    // the small JSON write must not race the delivery. The prose report
    // duplicates the delivery text, so it stays off the critical path.
    if (resultMeta) {
      await writeSubagentResultMeta(executionId, resultMeta);
    }
    const [delivered] = await Promise.all([
      deliverTerminalFollowUp({ text: msg, origin: 'subagent_result' }),
      writeSubagentReport(executionId, msg),
    ]);
    return delivered;
  }

  function onProgress(update: SubagentProgressUpdate): void {
    if (deliveryState.isDelivered()) return;
    const msg = formatSubagentProgress(executionId, agentName, update);
    void deliverFollowUp({ text: msg, origin: 'subagent_result' });
  }

  async function deliverSubagentError(
    err: unknown,
    result?: AgentFlowResult,
  ): Promise<void> {
    settleSubagentCost(result);
    const wallTimeMs = Date.now() - startedAt;
    const msg = formatSubagentError(executionId, agentName, err, {
      wallTimeMs,
      workingDirectory,
      memoryMisses: result?.memoryMisses,
    });
    // Overwrite any interim success manifest from onBeforeWaiting so
    // /executions/{id}/result never claims success for a failed run.
    await persistAndDeliverTerminal(
      msg,
      buildSubagentFailureResultMeta(agentName, result, wallTimeMs),
    );
  }

  const promise = executeAgent(configPayload, executionId, {
    runtimeHost,
    isSubagent: true,
    enforceCategory: true,
    parentStreamId: orchestratorStreamId,
    delegationDepth: parentDelegationDepth + 1,
    approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
    runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
    toolEditApprovalHandler: parentContext.toolEditApprovalHandler,
    onStreamResolved: (resolvedStreamId) => {
      childStreamId = resolvedStreamId;
      inheritChildStreamApprovals(resolvedStreamId);
    },
    onProgress,
    onFollowUpConsumed: () => {
      deliveryState.markPending();
    },
    onBeforeWaiting: async (lastResponse, touchedFiles, memoryMisses) => {
      const deliveryDecision =
        deliveryState.resolveBeforeWaiting(childStreamId);
      if (deliveryDecision === SUBAGENT_DELIVERY_DECISION.AlreadyDelivered) {
        return true;
      }
      if (deliveryDecision === SUBAGENT_DELIVERY_DECISION.MissingStream) {
        return false;
      }
      const resolvedChildStreamId = childStreamId;
      if (!resolvedChildStreamId) return false;

      const interimResult = {
        category: 'toolUse' as const,
        // The turn finished and the subagent is entering WAITING — for the
        // orchestrator this interim delivery is a completed turn.
        outcome: 'completed' as const,
        lastResponse,
        touchedFiles,
        executionId,
        streamId: resolvedChildStreamId,
        memoryMisses: memoryMisses.length > 0 ? [...memoryMisses] : undefined,
      };
      const wallTimeMs = Date.now() - startedAt;
      const msg = formatSubagentDelivery(agentName, interimResult, {
        wallTimeMs,
        workingDirectory,
      });
      // Claim only the enqueue step: formatting failures before this still
      // leave onCompleted/onError available as terminal fallbacks.
      return await persistAndDeliverTerminal(
        msg,
        buildSubagentResultMeta(agentName, interimResult, { wallTimeMs }),
      );
    },
    onCompleted: async (result) => {
      settleSubagentCost(result);
      const { msg, resultMeta } = await subagentDeliveryMessage(
        executionId,
        agentName,
        result,
        { startedAt, workingDirectory },
      );
      await persistAndDeliverTerminal(msg, resultMeta);
    },
    onError: (err, result) => deliverSubagentError(err, result),
  });
  promise
    // Await the error delivery so the registry entry is not torn down while
    // the delivery (and any resume-based follow-up routing) is in flight.
    .catch((err: unknown) => deliverSubagentError(err))
    .catch((deliveryErr: unknown) => {
      logger.warn(
        'subagentDelivery',
        `Failed to deliver subagent error for ${executionId}: ${toErrorMessage(deliveryErr)}`,
      );
    })
    .finally(() => {
      subagentDeliveryRegistry.finish(executionId);
    });
  const isToolUse = configPayload.agentCategory === AgentCategory.ToolUse;
  const meta = options?.approvalMeta;
  const metaLines: string[] = [];
  if (meta) {
    const modelInfo = meta.modelOverride
      ? `Model: ${meta.modelOverride} (overridden from ${meta.requestedModel ?? 'default'})`
      : `Model: ${configPayload.model}`;
    const agentInfo = meta.agentOverride
      ? ` Agent: ${meta.agentOverride} (overridden from ${meta.requestedAgent ?? 'default'}).`
      : '';
    metaLines.push(
      `Approval: ${meta.autoApproved ? 'auto-approved' : 'user-approved'}. ${modelInfo}.${agentInfo}`,
    );
  }
  return {
    status: 'executed',
    summary: `Launched '${agentName}' (async)`,
    output: [
      `Subagent '${agentName}' launched. Result will be delivered automatically as a follow-up message when complete.`,
      `Execution ID: ${executionId}`,
      ...metaLines,
      `To check intermediate progress: executions tool with path=/executions/${executionId} and action=wait (waits for next status change).`,
      ...(isToolUse
        ? [
            `To send follow-up instructions after delivery: use delegate_agent with execution_id set to this ID.`,
          ]
        : []),
    ].join('\n'),
  };
}
