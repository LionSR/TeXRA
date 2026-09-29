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
import { childToolRefusal } from '@agent/runtime/agentToolResolution';
import { offeredBy } from '@agent/runtime/loop/step';
import { registerRun } from '@agent/storage/runLifecycle';

// Local imports
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { createNativeSubagentStrategy } from '@agent/runtime/nativeSubagentStrategy';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentCategory,
  TODO_STATUS,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  configureDelegatedChildApprovals,
  type DelegatedChildApproval,
} from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';
import { executeSubagentForDeliveryInBand } from './inBandSubagentRun';
import type { DelegationParent } from './proposalFlow';

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
  /** How the child's own grants record the approval; `inherit` when absent. */
  childApproval?: DelegatedChildApproval;
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
  parent: DelegationParent,
  configPayload: AgentConfigPayload,
  parentRunId: RunId,
  options?: { approvalMeta?: ApprovalMeta },
) {
  const parentSession = parent.run.session;
  const delegationAgentScope = parent.run.delegationAgentScope ?? undefined;
  const childConfigPayload: AgentConfigPayload = {
    ...configPayload,
    ...(delegationAgentScope ? { delegationAgentScope } : {}),
  };
  const workingDirectory = childConfigPayload.workingDirectory ?? undefined;
  const agentName = configPayload.agent;

  const inheritChildRunApprovals = (resolvedRunId: RunId): void => {
    // Live inherited bypass values: each approval follows the parent's
    // corresponding bypass, so a partial grant propagates only that grant.
    // Complete delegated-task approval also reaches nested orchestrators.
    configureDelegatedChildApprovals(
      resolvedRunId,
      parentRunId,
      options?.approvalMeta?.childApproval ?? 'inherit',
      parentSession,
    );
  };

  // The most the child may be offered: what the parent's step offers now.
  const parentOffered = yield* offeredBy(parent.run);
  if (parent.run.toolPolicy.stopAfterCycle) {
    // The parent is mid-cycle, so child progress cannot be delivered as a
    // follow-up the way the detached loop does it. Degrade deliberately to the
    // parent run's trace (the same trace nested tool activity projects onto):
    // the orchestrator's transcript still records what its child is doing.
    const parentTrace = parent.run.logger;
    const notifyParentTrace = (update: SubagentProgressUpdate): void => {
      const line = describeSubagentProgress(agentName, update);
      if (line) parentTrace.info(line);
    };
    const deliveryExit = yield* Effect.exit(
      executeSubagentForDeliveryInBand({
        configPayload: childConfigPayload,
        parentRunId,
        session: parentSession,
        parentOffered,
        onRunResolved: inheritChildRunApprovals,
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
    }
    return errorResult(toErrorMessage(Cause.squash(deliveryExit.cause)), {
      summary: `Subagent '${agentName}' failed`,
    });
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
  // A detached child launches after this call settles, so a child that needs
  // a plugin its parent's step lacks is refused here, on the call
  // that asked for it, before any row records it.
  const refusal = childToolRefusal(
    parentOffered,
    definition.setting.tools,
    agentName,
  );
  if (refusal !== undefined) {
    return errorResult(refusal, {
      summary: `Subagent '${agentName}' not launched`,
    });
  }
  const isToolUse = config.agentCategory === AgentCategory.ToolUse;
  // One decision for the child's follow-up capability: the roster row it
  // registers under and the run it launches must agree.
  const userFollowUpSupport = isToolUse
    ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
    : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* registerRun(parentSession, runId, config, {
        identity: { kind: 'agent', agent: config.agent },
        userFollowUpSupport,
        parentRunId,
      });

      const strategyParams = {
        definition,
        runId,
        parentRunId,
        session: parentSession,
        startedAt,
        workingDirectory,
        parentOffered,
        onRunResolved: inheritChildRunApprovals,
        userFollowUpSupport,
      };

      yield* startDetachedChildRunLoop({
        session: parentSession,
        runId,
        parentRunId,
        agentName,
        buildLaunch: () =>
          restore(Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => ({
                strategy: createNativeSubagentStrategy(strategyParams),
                onLoopFailed: (error: unknown) =>
                  Effect.logError(
                    `Subagent '${agentName}' run loop failed after launch`,
                  ).pipe(
                    Effect.annotateLogs({ data: error }),
                    withLogChannel('childRunLoop'),
                  ),
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
            `To send follow-up instructions: executions tool, action=send, path=/executions/${runId}.`,
          ]
        : []),
    ].join('\n'),
    `Launched '${agentName}' (async)`,
  );
});
