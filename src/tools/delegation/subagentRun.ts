/**
 * Subagent run and async delivery lifecycle for delegation tools.
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue, driven by the shared `childRunLoop` over a native strategy. One-shot/
 * headless parent runs execute subagents in-band because there is no later
 * interactive follow-up turn to consume async delivery.
 */

// Third-party imports
import { Effect } from 'effect';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { childToolRefusal } from '@agent/runtime/agentToolResolution';
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
  type OfferedTool,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { type DelegatedChildApproval } from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import type { RunToolCall } from '@tools/core/toolRun';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * One compact line per child progress update, for an awaited child: the
 * `agent` call streams it to its card, the delegation tools' in-band arm to
 * the parent run's trace. Returns undefined for updates with nothing worth a
 * line.
 */
export function describeSubagentProgress(
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
export interface ApprovalMeta {
  autoApproved: boolean;
  /** How the child's own grants record the approval; `inherit` when absent. */
  childApproval?: DelegatedChildApproval;
  modelOverride?: string;
  requestedModel?: string;
  agentOverride?: string;
  requestedAgent?: string;
}

/**
 * Launch one detached child under `runId` and return the receipt the model
 * reads: the child's result arrives later as a follow-up. A child that needs
 * a plugin its parent's step lacks is refused here, before any row records
 * it.
 */
export const launchDetachedSubagent = Effect.fn('launchDetachedSubagent')(
  function* (
    parent: RunToolCall,
    childConfigPayload: AgentConfigPayload,
    launch: {
      readonly parentRunId: RunId;
      readonly runId: RunId;
      /** The most the child may be offered: its parent step's tools. */
      readonly parentOffered: readonly OfferedTool[];
      readonly inheritChildRunApprovals: (resolvedRunId: RunId) => void;
      readonly approvalMeta?: ApprovalMeta;
    },
  ) {
    const { parentRunId, runId, parentOffered, inheritChildRunApprovals } =
      launch;
    const parentSession = parent.run.session;
    const workingDirectory = childConfigPayload.workingDirectory ?? undefined;
    const agentName = childConfigPayload.agent;
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
    // One decision for the child's follow-up capability: the child row it
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
          ...(parent.logId !== undefined && { parentCard: parent.logId }),
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
        };

        yield* startDetachedChildRunLoop({
          session: parentSession,
          runId,
          parentRunId,
          agentName,
          budgeted: true,
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

    const meta = launch.approvalMeta;
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
    const receipt = executed(
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
    return receipt;
  },
);
