/**
 * Subagent execution and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue, driven by the shared `childRunLoop` over a native strategy. One-shot/
 * headless parent runs execute subagents in-band because there is no later
 * interactive follow-up turn to consume async delivery.
 */

// Local imports
import { registerExecution } from '@agent/storage';
import { createChannelTrace } from '@agent/trace';
import {
  captureOwnedExecutionLease,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import {
  getRunContextExecutionId,
  getRunContextSession,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { startChildRunLoop } from '@agent/runtime/childRunLoop';
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { executeSubagentForDeliveryInBand } from './inBandSubagentExecution';

// `createNativeSubagentStrategy` is lazy-imported below. The strategy module
// imports `@agent/runtime/executeAgent` (directly, or transitively via
// `resumeQueuedToolUseFromResumeData`), which pulls in `runToolUseFlow.ts` ->
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
  const parentSession = getRunContextSession(parentContext);
  if (!parentContext || !parentSession) {
    return {
      status: 'error',
      summary: 'Delegation session unavailable',
      error:
        'delegate_agent and delegate_workflow require an active agent session. Run delegation from an active agent session, or ensure the tool run context provides its owning session.',
      diagnostics: {
        type: 'missing_session',
        tools: ['delegate_agent', 'delegate_workflow'],
      },
    };
  }
  const parentExecutionId = getRunContextExecutionId(parentContext);
  // Captured now (while the launching tool call's ALS frame is live) so the
  // child-run loop can still roll the child's cost into the parent run after
  // this tool call has returned. Subagents count toward parent usage totals
  // only — they never drive the loop.
  const recordSubagentCost =
    getCurrentToolCallContext()?.hooks?.recordSubagentCost;
  const recordCost = (totalCostUsd: number | undefined): void => {
    recordSubagentCost?.(totalCostUsd ?? 0);
  };

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
    // Live per-kind ancestry: each approval follows the parent's corresponding
    // bypass, so a partial grant propagates only that grant, while complete
    // delegated-task approval also reaches nested orchestrators.
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
        session: parentSession,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        onStreamResolved: inheritChildStreamApprovals,
        onCost: recordCost,
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
  const config = AgentConfigSchema.parse(childConfigPayload);
  await registerExecution(executionId, config, agentName, parentExecutionId);
  const runWithOwnership = captureOwnedExecutionLease(executionId);

  return await runWithOwnership(async () => {
    const isToolUse = config.agentCategory === AgentCategory.ToolUse;
    // Must match the id `buildAgentLaunchContext` actually reserves for this
    // executionId (see AgentLaunchContext.ts's `reservedStreamId`), or the
    // loop acquires the wrong follow-up queue/interrupt slot. That reservation
    // uses the canonical config's agent/model — not the `agentName` parameter,
    // which callers may resolve differently
    // (e.g. an approved agent override's display name vs. its registry name).
    // Derive from the exact same fields, not a parallel formula.
    const childStreamId = getStreamTabId(config.agent, config.model, {
      executionId,
    });
    const strategyParams = {
      config,
      agentCategoryExplicit: childConfigPayload.agentCategory !== undefined,
      executionId,
      agentName,
      orchestratorStreamId,
      parentSession,
      startedAt,
      workingDirectory,
      approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
      runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
      onStreamResolved: inheritChildStreamApprovals,
    };

    try {
      const { createNativeSubagentStrategy } =
        await import('./nativeSubagentStrategy.js');
      const { completion } = startChildRunLoop({
        childStreamId,
        parentStreamId: orchestratorStreamId,
        executionId,
        agentName,
        strategy: createNativeSubagentStrategy(strategyParams),
        recordCost,
      });
      void completion.catch((error: unknown) => {
        createChannelTrace('childRunLoop').error(
          `Subagent '${agentName}' run loop failed after launch`,
          { data: error },
        );
      });
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
  });
}
