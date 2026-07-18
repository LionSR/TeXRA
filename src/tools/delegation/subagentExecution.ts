/**
 * Subagent execution and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue, driven by the shared `childRunLoop` over a native strategy. One-shot/
 * headless parent runs execute subagents in-band because there is no later
 * interactive follow-up turn to consume async delivery.
 */

// Local imports - agent
import {
  registerExecution,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { currentSession } from '@agent/runtime/SessionHandle';
import {
  getRunContextExecutionId,
  getRunContextRuntimeHost,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { startChildRunLoop } from '@agent/runtime/childRunLoop';

// Local imports - tools
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { executeSubagentForDeliveryInBand } from './inBandSubagentExecution';

// `createNativeToolUseStrategy`/`createNativeWorkflowStrategy` are lazy-
// imported below. Both strategy modules import
// `@agent/runtime/executeAgent` (directly, or transitively via
// `resumeQueuedToolUseSnapshot`), which pulls in `runToolUseFlow.ts` ->
// `@tools/registry`. An eager import here would close the same
// registry -> DelegationTools -> proposalFlow -> subagentExecution cycle
// the existing `executeAgent` lazy import already avoids.

// ============================================================================
// Shared utilities
// ============================================================================

/** Metadata about how the delegation was approved, included in the tool result. */
interface ApprovalMeta {
  autoApproved: boolean;
  modelOverride?: string;
  requestedModel?: string;
  agentOverride?: string;
  requestedAgent?: string;
}

/**
 * Execute a subagent through the delegation tool boundary.
 * Pre-generates executionId so all IDs (tool return, XML delivery, error)
 * are consistent and usable with the executions tool.
 *
 * Result is delivered via the shared child-run loop's follow-up queue
 * delivery — the same choreography every child-run type shares.
 */
export async function executeSubagent(
  configPayload: AgentConfigPayload,
  agentName: string,
  orchestratorStreamId: StreamTabId,
  options?: { approvalMeta?: ApprovalMeta },
): Promise<ToolResult> {
  const parentContext = tryUseRunContext();
  const runtimeHost = getRunContextRuntimeHost(parentContext);
  if (!parentContext || !runtimeHost) {
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
  const parentExecutionId = getRunContextExecutionId(parentContext);
  const parentSession = currentSession();
  // Captured now (while the launching tool call's ALS frame is live) so the
  // child-run loop can still roll the child's cost into the parent run after
  // this tool call has returned. Subagents count toward parent usage totals
  // only — they never drive the loop.
  const recordSubagentCost =
    getCurrentToolCallContext()?.hooks?.recordSubagentCost;
  let subagentCostSettled = false;
  function settleSubagentCost(totalCostUsd: number | undefined): void {
    if (subagentCostSettled) return;
    subagentCostSettled = true;
    recordSubagentCost?.(totalCostUsd ?? 0);
  }

  const delegationAgentScope =
    parentContext.kind === 'launch'
      ? parentContext.runScope.delegationAgentScope
      : undefined;
  const childConfigPayload: AgentConfigPayload = {
    ...configPayload,
    ...(delegationAgentScope ? { delegationAgentScope } : {}),
  };
  const workingDirectory = childConfigPayload.workingDirectory ?? undefined;

  const inheritChildStreamApprovals = (resolvedStreamId: StreamTabId): void => {
    // Live per-kind ancestry: bash and tool-edit each follow the parent's own
    // bypass, so a bash-only parent (CLI AUTO-BASH without AUTO-APPROVE) still
    // propagates only bash, and a YOLO toggle on the parent mid-run reaches
    // already-launched children.
    configureDelegatedChildApprovals(
      resolvedStreamId,
      orchestratorStreamId,
      options?.approvalMeta?.autoApproved === true
        ? 'auto-approved'
        : 'inherit',
    );
  };

  if (parentContext.stopAfterCycle) {
    try {
      const { result, delivery } = await executeSubagentForDeliveryInBand({
        configPayload: childConfigPayload,
        agentName,
        parentExecutionId,
        parentStreamId: orchestratorStreamId,
        runtimeHost,
        session: parentSession,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        onStreamResolved: inheritChildStreamApprovals,
        onCost: settleSubagentCost,
      });
      return {
        status: 'executed',
        summary:
          result.outcome === 'cancelled'
            ? `Cancelled '${agentName}'`
            : `Completed '${agentName}'`,
        output: delivery,
      };
    } catch (err) {
      return {
        status: 'error',
        summary: `Subagent '${agentName}' failed`,
        error: toErrorMessage(err),
      };
    }
  }

  const executionId = generateExecutionId();
  const startedAt = Date.now();
  const syntheticConfig = AgentConfigSchema.parse(childConfigPayload);
  await registerExecution(
    executionId,
    syntheticConfig,
    agentName,
    parentExecutionId,
  );

  const isToolUse = childConfigPayload.agentCategory === AgentCategory.ToolUse;
  // Must match the id `buildAgentLaunchContext` actually reserves for this
  // executionId (see AgentLaunchContext.ts's `reservedStreamId`), or the
  // loop acquires the wrong follow-up queue/interrupt slot. That reservation
  // uses the RAW, unparsed `configPayload.agent`/`configPayload.model` — not
  // `AgentConfigSchema.parse(configPayload).agent` (the later `config.agent`
  // recomputation never wins; the upfront reservation always does) — and
  // NOT the `agentName` parameter, which callers may resolve differently
  // (e.g. an approved agent override's display name vs. its registry name).
  // Derive from the exact same fields, not a parallel formula.
  const childStreamId = getStreamTabId(
    childConfigPayload.agent,
    childConfigPayload.model,
    { executionId },
  );
  const strategyParams = {
    configPayload: childConfigPayload,
    executionId,
    agentName,
    orchestratorStreamId,
    parentSession,
    runtimeHost,
    startedAt,
    workingDirectory,
    approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
    runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
    onStreamResolved: inheritChildStreamApprovals,
  };

  try {
    if (isToolUse) {
      const { createNativeToolUseStrategy } =
        await import('./nativeToolUseStrategy');
      startChildRunLoop({
        childStreamId,
        parentStreamId: orchestratorStreamId,
        executionId,
        agentName,
        strategy: createNativeToolUseStrategy(strategyParams),
        recordCost: settleSubagentCost,
      });
    } else {
      const { createNativeWorkflowStrategy } =
        await import('./nativeWorkflowStrategy');
      startChildRunLoop({
        childStreamId,
        parentStreamId: orchestratorStreamId,
        executionId,
        agentName,
        strategy: createNativeWorkflowStrategy(strategyParams),
        recordCost: settleSubagentCost,
      });
    }
  } catch (error) {
    throw await releaseOwnedExecutionLeaseAfterFailure(executionId, error);
  }

  const meta = options?.approvalMeta;
  const metaLines: string[] = [];
  if (meta) {
    const modelInfo = meta.modelOverride
      ? `Model: ${meta.modelOverride} (overridden from ${meta.requestedModel ?? 'default'})`
      : `Model: ${childConfigPayload.model}`;
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
