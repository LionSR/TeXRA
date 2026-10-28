/**
 * The detached launch of an `agent` call's child: its result is delivered
 * later through the follow-up queue, driven by the shared `childRunLoop`
 * over a native strategy. An awaited call runs its child in band instead
 * (`inBandSubagentRun.ts`).
 */

// Third-party imports
import { Clock, Effect, Schema } from 'effect';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';

// Local imports
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { createNativeSubagentStrategy } from '@agent/runtime/nativeSubagentStrategy';
import { type RunToolCall } from '@agent/runtime/RunCall';
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import {
  AgentConfigSchema,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { executed } from '@tools/core/result';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';

/**
 * One compact line per child progress update, for an awaited child: the
 * `agent` call streams it to its card. Returns undefined for updates with
 * nothing worth a line.
 */
export function describeSubagentProgress(
  agentName: string,
  update: SubagentProgressUpdate,
): string | undefined {
  switch (update.kind) {
    case 'started':
      return `Subagent '${agentName}' started`;
    case 'plan':
      return update.plan
        ? `Subagent '${agentName}' plan: ${update.plan.objective}`
        : undefined;
    case 'overview':
      return `Subagent '${agentName}': ${update.toolCallCount} tool calls, ${update.filesChanged.length} files changed`;
  }
}

/** How a delegation was approved, as the child's own grants record it:
 *  by the user's one-off answer (`inherit`), or by the run's proposal
 *  bypass, a human's (`auto-approved`) or an autonomous goal's. */
export type DelegatedChildApproval =
  'inherit' | 'auto-approved' | 'goal-approved';

/**
 * The grants a delegated child is registered with, stamped on its
 * `run.start`. Beyond them it inherits its parent's live grants through the
 * parent edge, kind by kind, so the CLI's distinct AUTO-BASH and
 * AUTO-APPROVE grants reach it exactly as set, and a toggle on the parent
 * after the child started reaches it too. A child a goal's grant approved
 * gets a goal grant of its own, never a human value, so a resume leaves it
 * off until a human re-arms the goal.
 */
export function delegatedChildGrants(
  approval: DelegatedChildApproval,
): ApprovalGrants {
  switch (approval) {
    case 'inherit':
      return NO_APPROVAL_GRANTS;
    case 'auto-approved':
      return { own: { toolEdit: 'on' }, goal: [] };
    case 'goal-approved':
      return { own: {}, goal: ['toolEdit'] };
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
 * reads: the child's result arrives later as a follow-up.
 */
export const launchDetachedSubagent = Effect.fn('launchDetachedSubagent')(
  function* (
    parent: RunToolCall,
    childConfigPayload: AgentConfigPayload,
    launch: {
      readonly runId: RunId;
      /** The grants the child is registered with. */
      readonly grants: ApprovalGrants;
      readonly approvalMeta?: ApprovalMeta;
    },
  ) {
    const { runId, grants } = launch;
    const { session: parentSession, runId: parentRunId } = parent.run;
    const workingDirectory = childConfigPayload.workingDirectory ?? undefined;
    const agentName = childConfigPayload.agent;
    const startedAt = yield* Clock.currentTimeMillis;
    const definition = yield* prepareAgentDefinition({
      config: Schema.decodeUnknownSync(AgentConfigSchema)(childConfigPayload),
      session: parentSession,
      suppressErrorNotification: true,
    });
    const { config } = definition;
    // A conversation takes follow-ups; a run opened on a script (a document
    // task) ends with its script. One decision: the child row it registers
    // under and the run it launches must agree.
    const conversation = config.script == null;
    const userFollowUpSupport = conversation
      ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
      : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // The child registers with its opening, which its run commits.
        const strategyParams = {
          definition,
          registration: {
            identity: { kind: 'agent' as const, agent: config.agent },
            userFollowUpSupport,
            parentRunId,
            parentCall: { callId: parent.callId, card: parent.logId },
            grants,
          },
          runId,
          parentRunId,
          session: parentSession,
          startedAt,
          workingDirectory,
        };

        yield* startDetachedChildRunLoop({
          session: parentSession,
          runId,
          parentRunId,
          agentName,
          buildLaunch: () =>
            restore(Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => createNativeSubagentStrategy(strategyParams)),
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
        ...(conversation
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
