/**
 * Subagent run and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue, driven by the shared `childRunLoop` over a native strategy. One-shot/
 * headless parent runs execute subagents in-band because there is no later
 * interactive follow-up turn to consume async delivery.
 */

// Third-party imports
import { Cause, Effect, Exit } from 'effect';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';

// Local imports
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import {
  getRunContextSession,
  runInSession,
  type RunContext,
} from '@agent/runtime/RunContext';
import type { ToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { createLog } from '@logger/logUtils';
import {
  AgentCategory,
  TODO_STATUS,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import { generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  registerChildRun,
  startDetachedChildRunLoop,
} from './detachedChildRun';
import { executeSubagentForDeliveryInBand } from './inBandSubagentRun';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';

// ============================================================================
// Shared utilities
// ============================================================================

const log = createLog('childRunLoop');

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
 * Pre-generates runId so all IDs (tool return, XML delivery, error)
 * are consistent and usable with the executions tool.
 *
 * Result is delivered via the shared child-run loop's follow-up queue
 * delivery — the same choreography every child-run type shares.
 */
export const executeSubagent = Effect.fn('executeSubagent')(function* (
  parentContext: RunContext | undefined,
  callContext: ToolCallContext | undefined,
  configPayload: AgentConfigPayload,
  agentName: string,
  parentRunId: RunId,
  options?: { approvalMeta?: ApprovalMeta },
) {
  const parentSession = parentContext
    ? getRunContextSession(parentContext)
    : undefined;
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
  // Captured now (while the launching tool call's ALS frame is live) so the
  // child-run loop can still roll the child's cost into the parent run after
  // this tool call has returned. Subagents count toward parent usage totals
  // only — they never drive the loop.
  const recordSubagentCost = callContext?.hooks?.recordSubagentCost;
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

  const inheritChildStreamApprovals = (resolvedRunId: RunId): void => {
    // Live inherited bypass values: each approval follows the parent's
    // corresponding bypass, so a partial grant propagates only that grant.
    // Complete delegated-task approval also reaches nested orchestrators.
    configureDelegatedChildApprovals(
      resolvedRunId,
      parentRunId,
      options?.approvalMeta?.autoApproved === true
        ? 'auto-approved'
        : 'inherit',
      parentSession,
    );
  };

  if (parentContext.stopAfterCycle) {
    // The parent is mid-cycle, so child progress cannot be delivered as a
    // follow-up the way the detached loop does it. Degrade deliberately to the
    // parent run's trace (the same trace nested tool activity projects onto):
    // the orchestrator's transcript still records what its child is doing.
    const parentTrace = callContext?.trace;
    const notifyParentTrace = (update: SubagentProgressUpdate): void => {
      const line = describeSubagentProgress(agentName, update);
      if (line) parentTrace?.info(line);
    };
    const deliveryExit = yield* Effect.exit(
      executeSubagentForDeliveryInBand({
        configPayload: childConfigPayload,
        agentName,
        parentRunId,
        session: parentSession,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        onApprovalPolicyDenial: parentContext.onApprovalPolicyDenial,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        onRunResolved: inheritChildStreamApprovals,
        onCost: recordCost,
        notify: notifyParentTrace,
      }),
    );
    if (Exit.isSuccess(deliveryExit)) {
      const { result, delivery } = deliveryExit.value;
      return executed(
        delivery,
        result.outcome === 'cancelled'
          ? `Cancelled '${agentName}'`
          : `Completed '${agentName}'`,
      );
    } else {
      return errorResult(toErrorMessage(Cause.squash(deliveryExit.cause)), {
        summary: `Subagent '${agentName}' failed`,
      });
    }
  }

  const runId = generateRunId();
  const startedAt = Date.now();
  const definition = yield* prepareAgentDefinition({
    config: AgentConfigSchema.parse(childConfigPayload),
    session: parentSession,
    enforceCategory: childConfigPayload.agentCategory !== undefined,
    suppressErrorNotification: true,
  });
  const { config } = definition;
  const isToolUse = config.agentCategory === AgentCategory.ToolUse;
  // One decision for the child's follow-up capability: the roster row it
  // registers under and the run it launches must agree.
  const userFollowUpSupport = isToolUse
    ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
    : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* registerChildRun(parentSession, {
        runId,
        config,
        agentName,
        userFollowUpSupport,
        parentRunId: parentRunId,
      });

      const strategyParams = {
        definition,
        runId,
        agentName,
        parentRunId,
        session: parentSession,
        startedAt,
        workingDirectory,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        onApprovalPolicyDenial: parentContext.onApprovalPolicyDenial,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        onRunResolved: inheritChildStreamApprovals,
        userFollowUpSupport,
      };

      yield* startDetachedChildRunLoop({
        session: parentSession,
        runId,
        parentRunId,
        agentName,
        recordCost,
        buildLaunch: () =>
          restore(Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => ({
                strategy: createNativeSubagentStrategy(strategyParams),
                onLoopFailed: (error: unknown): void => {
                  log.error(
                    `Subagent '${agentName}' run loop failed after launch`,
                    {
                      data: error,
                    },
                  );
                },
              })),
            ),
          ),
      });
    }),
  );

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
      `Run ID: ${runId}`,
      ...metaLines,
      `The result arrives automatically. Continue other work meanwhile. To check progress: executions tool with path=/executions/${runId}; use action=wait only when you cannot proceed without it.`,
      ...(isToolUse
        ? [
            `To send follow-up instructions after delivery: use delegate_agent with execution_id set to this ID.`,
          ]
        : []),
    ].join('\n'),
    `Launched '${agentName}' (async)`,
  );
});
