/**
 * Subagent execution and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue. One-shot/headless parent runs execute subagents in-band because there
 * is no later interactive follow-up turn to consume async delivery.
 */

// Local imports - agent
import { registerExecution } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { evaluateCurrentDelegationGate } from '@agent/runtime/delegationPolicy';
import { currentSession } from '@agent/runtime/SessionHandle';
import {
  getAgentFlowErrorResult,
  type AgentFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import {
  enableYoloOnChildStream,
  inheritBashBypassOnChildStream,
} from '@tools/approval';
import {
  buildSubagentFailureResultMeta,
  formatSubagentError,
} from '@tools/subagentResults';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - utils
import { generateExecutionId } from '@utils/core/executionId';
import {
  NativeSubagentStrategy,
  subagentDeliveryMessage,
  writeSubagentReport,
  writeSubagentResultMeta,
} from './nativeSubagentStrategy';

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

  const nativeStrategy = new NativeSubagentStrategy({
    executionId,
    agentName,
    orchestratorStreamId,
    parentSession,
    startedAt,
    workingDirectory,
    settleSubagentCost,
  });

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
      nativeStrategy.setChildStreamId(resolvedStreamId);
      inheritChildStreamApprovals(resolvedStreamId);
    },
    onProgress: (update) => nativeStrategy.onProgress(update),
    onFollowUpConsumed: () => nativeStrategy.onFollowUpConsumed(),
    onBeforeWaiting: (lastResponse, touchedFiles, memoryMisses) =>
      nativeStrategy.onBeforeWaiting(lastResponse, touchedFiles, memoryMisses),
    onCompleted: (result) => nativeStrategy.onCompleted(result),
    onError: (err, result) => nativeStrategy.onError(err, result),
  });
  nativeStrategy.attachPromise(promise);
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
