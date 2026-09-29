/**
 * Proposal/approval handshake and agent/model resolution for delegation tools.
 *
 * If proposal bypass is active for a stream, launches immediately; otherwise
 * waits for user approval via `session.interactions` before executing.
 */

// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports
import {
  findAgentByIdentifier,
  resolveDelegationScopeAgents,
  type AgentRosterStores,
} from '@agent/index/agentRegistry';
import type { ToolCallShape } from '@agent/runtime/ToolCall';
import type {
  AgentDelegationScope,
  RequestDecision,
  ToolError,
  ToolResult,
  ToolUseAgentProposal,
  WorkflowAgentProposal,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import {
  decideProposalApproval,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import { refusalOf } from '@shared/session/approvalDecision';
import type { DelegatedChildApproval } from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import { requireToolRun, type ToolRun } from '@tools/core/toolRun';
import { generateShortId } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { selectAvailableDelegationModel } from './delegationAvailability';

// Local file imports
import { executeSubagent } from './subagentRun';

/** Invocation capabilities required by a delegation tool after its entry check. */
export interface DelegationParent extends ToolCallShape {
  readonly run: ToolRun;
}

/** Narrow a generic tool call to the capabilities every delegation path needs. */
export function requireDelegationParent(
  toolName: string,
  call: ToolCallShape,
): Effect.Effect<DelegationParent, ToolError> {
  return requireToolRun(toolName, call).pipe(
    Effect.map((run) => ({ ...call, run })),
  );
}

const DEFAULT_DELEGATION_REJECTION_FEEDBACK = [
  'No feedback provided.',
  'Do not retry the same or equivalent delegation unless the user explicitly asks for it;',
  'continue directly with available context, or ask the user a clarifying question.',
].join(' ');

/**
 * Return the visible agent entry, or throw with the current visible list. The
 * caller carries the resolved `source` onto the proposal so launch pins the
 * exact `(source, name)` entry instead of re-resolving the bare name.
 */
export const requireVisibleAgent = Effect.fn('requireVisibleAgent')(function* (
  stores: AgentRosterStores,
  category: AgentCategory,
  name: string,
  scope?: AgentDelegationScope,
) {
  const agents = yield* resolveDelegationScopeAgents(stores, scope, category);
  const agent = findAgentByIdentifier(agents, name);
  if (agent) return agent;
  return yield* Effect.fail(
    new Error(
      `Unknown ${category} agent '${name}'. Available: ${agents.map((a) => a.name).join(', ')}`,
    ),
  );
});

/** Resolve either category from the current roster, reporting both on failure. */
export const requireWorkflowOrToolUseAgent = Effect.fn(
  'requireWorkflowOrToolUseAgent',
)(function* (
  stores: AgentRosterStores,
  name: string,
  scope?: AgentDelegationScope,
) {
  const available: string[] = [];
  for (const category of [AgentCategory.Workflow, AgentCategory.ToolUse]) {
    const agents = yield* resolveDelegationScopeAgents(stores, scope, category);
    const agent = findAgentByIdentifier(agents, name);
    if (agent) return agent;
    available.push(
      `${category}: ${agents.map((a) => a.name).join(', ') || 'none'}`,
    );
  }
  return yield* Effect.fail(
    new Error(
      `Unknown workflow or toolUse agent '${name}'. Available: ${available.join('; ')}`,
    ),
  );
});

/** Build a concise summary of proposal parameters for rejection echo. */
function summarizeProposal(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): string {
  const parts = [`Agent: ${proposal.agent}`, `Model: ${proposal.model}`];
  if ('inputFiles' in proposal && proposal.inputFiles?.[0]) {
    parts.push(`File: ${proposal.inputFiles[0]}`);
  }
  if (proposal.memories.length > 0) {
    parts.push(`Memories: ${proposal.memories.join(', ')}`);
  }
  parts.push(
    `Instruction: "${truncateWithEllipsis(proposal.instruction, 120)}"`,
  );
  return parts.join(', ');
}

/** Convert proposal result to ToolResult. Returns null if approved. */
export function proposalResultToToolResult(
  result: RequestDecision,
  agentName: string,
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): ToolResult | null {
  const echo = summarizeProposal(proposal);

  if (result.action === 'approve') return null;
  if (result.action === 'setup') {
    return executed(
      `Delegation opened for editing. The user will run it manually when ready.\nYour delegation was: ${echo}`,
      `User opened '${agentName}' for editing`,
    );
  }

  const refusal = refusalOf('proposal', result);
  switch (refusal.action) {
    case 'cancel': {
      const cause = refusal.cause?.trim();
      const detail = cause ? `\n${cause}` : '';
      return errorResult(
        `Delegation approval for '${agentName}' was cancelled.\nYour delegation was: ${echo}${detail}`,
        { summary: `Delegation approval cancelled for '${agentName}'` },
      );
    }
    case 'deny': {
      const reason = refusal.reason.trim();
      const detail = reason ? `\n${reason}` : '';
      return errorResult(
        `Delegation to '${agentName}' was denied.\nYour delegation was: ${echo}${detail}`,
        { summary: `Delegation denied for '${agentName}'` },
      );
    }
    case 'reject': {
      const feedback = refusal.feedback?.trim();
      const feedbackLine = feedback
        ? `\nUser feedback: ${feedback}`
        : `\n${DEFAULT_DELEGATION_REJECTION_FEEDBACK}`;
      return errorResult(
        `Delegation to '${agentName}' was rejected.\nYour delegation was: ${echo}${feedbackLine}`,
        { summary: `User rejected delegation to '${agentName}'` },
      );
    }
  }
}

interface DelegationProposalDecision {
  readonly result: RequestDecision;
  /** How the child's own grants record this approval (see
   *  {@link DelegatedChildApproval}); `inherit` unless the run's proposal
   *  bypass supplied it. */
  readonly childApproval: DelegatedChildApproval;
}

/** Request the shared proposal decision, honoring the run's bypass policy. */
export const requestDelegationProposal = Effect.fn('requestDelegationProposal')(
  function* (
    proposal: WorkflowAgentProposal | ToolUseAgentProposal,
    parent: DelegationParent,
  ): Effect.fn.Return<
    DelegationProposalDecision,
    DatabaseNotOwner | DatabaseWriteFailed
  > {
    const { session, runId } = parent.run;
    const decision = decideProposalApproval({
      policy: session.approvalPolicy,
      scopedBypass: session.approvals.proposal.isBypassed(runId),
      canPresent: parent.run.toolPolicy.approvalPromptsUnavailable !== true,
    });
    switch (decision) {
      case 'deny-policy':
        session.interactions.approvalDenied({ kind: 'proposal' }, runId);
        return {
          result: {
            action: 'deny',
            reason: texraApprovalDenialMessage(decision),
          },
          childApproval: 'inherit',
        };
      case 'bypass':
        return {
          result: { action: 'approve' },
          childApproval: session.approvals.proposal.isAutonomous(runId)
            ? 'goal-approved'
            : 'auto-approved',
        };
      case 'unattended':
        // `inherit` keeps the child on inherited per-kind approval state,
        // so its bash and edits still gate.
        return { result: { action: 'approve' }, childApproval: 'inherit' };
      case 'present':
        break;
    }

    const result = yield* session.openRequest(runId, {
      kind: 'proposal',
      data: { requestId: generateShortId(), runId, ...proposal },
    });
    return { result, childApproval: 'inherit' };
  },
);

/**
 * Shared proposal-or-bypass flow used by both delegate_workflow and delegate_agent.
 *
 * If proposal bypass is active for this stream, skips the proposal and launches immediately.
 * Otherwise, waits for user approval via the session's host interactions.
 */
export const proposeAndExecute = Effect.fn('proposeAndExecute')(function* (
  parent: DelegationParent,
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
) {
  const decision = yield* requestDelegationProposal(proposal, parent);
  const { runId } = parent.run;
  if (decision.childApproval !== 'inherit') {
    // Preserve the approved delegation's edit grant explicitly on the child.
    // Proposal bypass can outlive the parent's ordinary edit-YOLO state.
    return yield* executeSubagent(parent, proposal, runId, {
      approvalMeta: {
        autoApproved: true,
        childApproval: decision.childApproval,
      },
    });
  }

  const { result } = decision;

  const nonApproveResult = proposalResultToToolResult(
    result,
    proposal.agent,
    proposal,
  );
  if (nonApproveResult) return nonApproveResult;
  if (result.action !== 'approve') {
    return yield* Effect.die(
      new Error('A proposal decision that is not an approve was not declined.'),
    );
  }

  // Every non-approve action returned above, so this is the approved path.
  // Route an approved model override through the same availability gate the
  // initial delegation uses (selectAvailableDelegationModel), so an unavailable
  // model fails synchronously here instead of launching and then failing
  // asynchronously. Re-selecting the proposed model needs no re-check — it was
  // already resolved when the proposal was built.
  let modelOverride: string | undefined;
  if (result.model && result.model !== proposal.model) {
    const modelExit = yield* Effect.exit(
      selectAvailableDelegationModel({
        requestedModel: result.model,
        parentModel: proposal.model,
        settings: parent.roots,
      }),
    );
    if (Exit.isFailure(modelExit)) {
      return errorResult(
        `Cannot launch with model '${result.model}': ${toErrorMessage(Cause.squash(modelExit.cause))} Re-propose the delegation.`,
        {
          summary: `Approved model override '${result.model}' is not available`,
        },
      );
    }
    modelOverride = modelExit.value;
  }

  const agentOverride =
    result.agent && result.agent !== proposal.agent ? result.agent : undefined;
  const resolvedAgentOverride = agentOverride
    ? findAgentByIdentifier(
        yield* resolveDelegationScopeAgents(
          parent.roots,
          parent.run.delegationAgentScope ?? undefined,
          proposal.agentCategory,
        ),
        agentOverride,
      )
    : undefined;

  // Re-validate against the current registry — between proposal display and
  // approval the agent may have been removed/renamed, or the approval could
  // carry a malformed value. Fail fast so the orchestrator sees the problem
  // synchronously instead of after an async launch.
  if (agentOverride && !resolvedAgentOverride) {
    return errorResult(
      `Cannot launch '${agentOverride}': it is not currently a visible ${proposal.agentCategory} agent (removed, renamed, or disabled since the proposal was shown). Re-propose the delegation.`,
      {
        summary: `Approved agent override '${agentOverride}' is not available`,
      },
    );
  }

  const effective = {
    ...proposal,
    ...(modelOverride && { model: modelOverride }),
    // Carry the override's resolved source alongside its name so launch pins
    // the exact entry the re-validation just resolved.
    ...(resolvedAgentOverride && {
      agent: resolvedAgentOverride.name,
      agentSource: resolvedAgentOverride.source,
    }),
  };
  return yield* executeSubagent(parent, effective, runId, {
    approvalMeta: {
      autoApproved: false,
      ...(modelOverride && {
        modelOverride,
        requestedModel: proposal.model,
      }),
      ...(agentOverride && {
        agentOverride,
        requestedAgent: proposal.agent,
      }),
    },
  });
});
