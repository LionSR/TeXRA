/**
 * Subagent execution and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue, driven by the shared `childRunLoop` over a native strategy. One-shot/
 * headless parent runs execute subagents in-band because there is no later
 * interactive follow-up turn to consume async delivery.
 */

// Local imports
import { createChannelTrace } from '@agent/trace';
import { registerOwnedExecution } from '@agent/storage/executionLifecycle';
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
import {
  AgentCategory,
  TODO_STATUS,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';
import { executeSubagentForDeliveryInBand } from './inBandSubagentExecution';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * One compact trace line per child progress update, for the in-band arm where
 * progress degrades to the parent run's trace instead of follow-up delivery.
 * Returns undefined for updates with nothing worth a line.
 */
function describeSubagentProgress(
  agentName: string,
  update: SubagentProgressUpdate,
): string | undefined {
  switch (update.kind) {
    case 'started':
      return `Subagent '${agentName}' started`;
    case 'todos': {
      const done = update.todos.filter(
        (todo) => todo.status === TODO_STATUS.COMPLETED,
      ).length;
      return `Subagent '${agentName}' todos: ${done}/${update.todos.length} complete`;
    }
    case 'plan':
      return update.plan
        ? `Subagent '${agentName}' plan: ${update.plan.objective}`
        : undefined;
    case 'overview':
      return `Subagent '${agentName}': ${update.toolCallCount} tool calls, ${update.filesChanged.length} files changed`;
  }
}

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
  parentStreamId: StreamTabId,
  options?: { approvalMeta?: ApprovalMeta },
): Promise<ToolResult> {
  const parentContext = tryUseRunContext();
  const parentSession = getRunContextSession(parentContext);
  if (!parentContext || !parentSession) {
    return errorResult(
      'delegate_agent and delegate_workflow require an active agent session. Run delegation from an active agent session, or ensure the tool run context provides its owning session.',
      {
        summary: 'Delegation session unavailable',
        diagnostics: {
          type: 'missing_session',
          tools: ['delegate_agent', 'delegate_workflow'],
        },
      },
    );
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
      parentStreamId,
      options?.approvalMeta?.autoApproved === true
        ? 'auto-approved'
        : 'inherit',
    );
  };

  if (parentContext.stopAfterCycle) {
    // The parent is mid-cycle, so child progress cannot be delivered as a
    // follow-up the way the detached loop does it. Degrade deliberately to the
    // parent run's trace (the same trace nested tool activity projects onto):
    // the orchestrator's transcript still records what its child is doing.
    const parentTrace = getCurrentToolCallContext()?.trace;
    const notifyParentTrace = (update: SubagentProgressUpdate): void => {
      const line = describeSubagentProgress(agentName, update);
      if (line) parentTrace?.info(line);
    };
    try {
      const { result, delivery } = await executeSubagentForDeliveryInBand({
        configPayload: childConfigPayload,
        agentName,
        parentExecutionId,
        parentStreamId,
        session: parentSession,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        onApprovalPolicyDenial: parentContext.onApprovalPolicyDenial,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        onStreamResolved: inheritChildStreamApprovals,
        onCost: recordCost,
        notify: notifyParentTrace,
      });
      return executed(
        delivery,
        result.outcome === 'cancelled'
          ? `Cancelled '${agentName}'`
          : `Completed '${agentName}'`,
      );
    } catch (err) {
      return errorResult(toErrorMessage(err), {
        summary: `Subagent '${agentName}' failed`,
      });
    }
  }

  const executionId = generateExecutionId();
  const startedAt = Date.now();
  const config = AgentConfigSchema.parse(childConfigPayload);
  // Must match the id `buildAgentLaunchContext` actually reserves for this
  // executionId (see AgentLaunchContext.ts's `reservedStreamId`), or the
  // loop acquires the wrong follow-up queue/interrupt slot. That reservation
  // uses the canonical config's agent/model — not the `agentName` parameter,
  // which callers may resolve differently
  // (e.g. an approved agent override's display name vs. its registry name).
  // Derive from the exact same fields, not a parallel formula.
  const childStreamId = getStreamTabId(config.agent, {
    executionId,
  });
  const runWithOwnership = await registerOwnedExecution(
    executionId,
    config,
    agentName,
    {
      streamId: childStreamId,
      identity: { kind: 'agent', agent: config.agent },
      userFollowUpSupport:
        config.agentCategory === AgentCategory.ToolUse
          ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
          : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      parentExecutionId,
    },
  );

  return await runWithOwnership(async () => {
    const isToolUse = config.agentCategory === AgentCategory.ToolUse;
    const strategyParams = {
      config,
      agentCategoryExplicit: childConfigPayload.agentCategory !== undefined,
      executionId,
      parentExecutionId,
      agentName,
      parentStreamId,
      session: parentSession,
      startedAt,
      workingDirectory,
      approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
      onApprovalPolicyDenial: parentContext.onApprovalPolicyDenial,
      runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
      onStreamResolved: inheritChildStreamApprovals,
    };

    await startDetachedChildRunLoop({
      executionId,
      parentStreamId,
      childStreamId,
      agentName,
      recordCost,
      buildLaunch: async () => ({
        strategy: createNativeSubagentStrategy(strategyParams),
        onLoopFailed: (error: unknown): void => {
          createChannelTrace('childRunLoop').error(
            `Subagent '${agentName}' run loop failed after launch`,
            { data: error },
          );
        },
      }),
    });

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
    return executed(
      [
        `Subagent '${agentName}' launched. Result will be delivered automatically as a follow-up message when complete.`,
        `Execution ID: ${executionId}`,
        ...metaLines,
        `The result arrives automatically. Continue other work meanwhile. To check progress: executions tool with path=/executions/${executionId}; use action=wait only when you cannot proceed without it.`,
        ...(isToolUse
          ? [
              `To send follow-up instructions after delivery: use delegate_agent with execution_id set to this ID.`,
            ]
          : []),
      ].join('\n'),
      `Launched '${agentName}' (async)`,
    );
  });
}
