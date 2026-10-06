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
  getCatalogAgent,
  resolveDelegationScopeAgents,
  type WorkspaceAgentsStores,
} from '@agent/index/agentRegistry';
import type { RunToolCall } from '@agent/runtime/RunCall';
import { isDocumentTaskConfig } from '@shared/schemas';
import type {
  AgentProposal,
  RequestDecision,
  ToolResult,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { RunHistoryRefused } from '@shared/session/runHistory';
import {
  decideProposalApproval,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import { refusalOf } from '@shared/session/approvalDecision';
import type { DelegatedChildApproval } from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { selectAvailableDelegationModel } from './delegationAvailability';

// Local file imports
import type { ApprovalMeta } from './subagentRun';

const DEFAULT_DELEGATION_REJECTION_FEEDBACK = [
  'No feedback provided.',
  'Do not retry the same or equivalent delegation unless the user explicitly asks for it;',
  'continue directly with available context, or ask the user a clarifying question.',
].join(' ');

/** Resolve `name` from the agents `run` may launch, listing them on
 *  failure. A recipe's calls name the agents TeXRA chose (its persona by
 *  key, the bundled `critic`), so they resolve past any scope or shadowing. */
export const requireAgent = Effect.fn('requireAgent')(function* (
  stores: WorkspaceAgentsStores,
  name: string,
  run: Pick<RunToolCall['run'], 'config' | 'delegationAgentScope'>,
) {
  const pinned = isDocumentTaskConfig(run.config)
    ? getCatalogAgent(name)
    : undefined;
  if (pinned) return pinned;
  const agents = yield* resolveDelegationScopeAgents(
    stores,
    run.delegationAgentScope ?? undefined,
  );
  const agent = findAgentByIdentifier(agents, name);
  if (agent) return agent;
  return yield* Effect.fail(
    new Error(
      `Unknown agent '${name}'. Available: ${agents.map((a) => a.name).join(', ') || 'none'}`,
    ),
  );
});

/** Build a concise summary of proposal parameters for rejection echo. */
function summarizeProposal(proposal: AgentProposal): string {
  const parts = [`Agent: ${proposal.agent}`, `Model: ${proposal.model}`];
  if (proposal.inputFiles[0]) {
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
function proposalResultToToolResult(
  result: RequestDecision,
  agentName: string,
  proposal: AgentProposal,
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

type ProposalRequestError =
  | DatabaseNotOwner
  | DatabaseReadFailed
  | DatabaseWriteFailed
  | RunHistoryRefused;

/** Request the shared proposal decision, honoring the run's bypass policy.
 *  `ask` presents it in place of this call's own proposal request: the
 *  calls of one script share one request (`agent`). */
const requestDelegationProposal = Effect.fn('requestDelegationProposal')(
  function* (
    proposal: AgentProposal,
    parent: RunToolCall,
    ask?: Effect.Effect<RequestDecision, ProposalRequestError>,
  ): Effect.fn.Return<DelegationProposalDecision, ProposalRequestError> {
    const { session, runId, config } = parent.run;
    // A document task's recipe calls its persona under the approval its
    // launch got.
    if (isDocumentTaskConfig(config))
      return { result: { action: 'approve' }, childApproval: 'inherit' };
    const decision = decideProposalApproval({
      policy: session.approvalPolicy,
      scopedBypass: session.approvals.bypass(runId, 'superYolo') !== null,
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
          childApproval:
            session.approvals.bypass(runId, 'superYolo') === 'goal'
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
    if (ask !== undefined)
      return { result: yield* ask, childApproval: 'inherit' };

    // A call made under a run opens its requests through the loop's door.
    const { requests } = parent;
    const result = yield* requests.open({
      kind: 'proposal',
      data: { requestId: requests.nextId('proposal'), runId, ...proposal },
    });
    return { result, childApproval: 'inherit' };
  },
);

/** How an approved delegation launches: the proposal with the agent and
 *  model the approval settled on, and how it was approved. */
interface ApprovedDelegation {
  readonly proposal: AgentProposal;
  readonly approvalMeta: ApprovalMeta;
}

/**
 * The proposal-or-bypass decision every delegation takes, and the agent and
 * model an approval changed, re-checked against the live lists: a declined
 * or unusable approval is the call's result, an approval is what launches.
 * A request the calls of one script share (`ask`) approves the script, not
 * one call's agent or model, so it changes neither.
 */
export const decideDelegation = Effect.fn('decideDelegation')(function* (
  parent: RunToolCall,
  proposal: AgentProposal,
  ask?: Effect.Effect<RequestDecision, ProposalRequestError>,
) {
  const decision = yield* requestDelegationProposal(proposal, parent, ask);
  if (decision.childApproval !== 'inherit') {
    // Preserve the approved delegation's edit grant explicitly on the child.
    // Proposal bypass can outlive the parent's ordinary edit-YOLO state.
    return {
      proposal,
      approvalMeta: {
        autoApproved: true,
        childApproval: decision.childApproval,
      },
    } satisfies ApprovedDelegation;
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
  const changes = ask === undefined;
  let modelOverride: string | undefined;
  if (changes && result.model && result.model !== proposal.model) {
    const modelExit = yield* Effect.exit(
      selectAvailableDelegationModel({
        requestedModel: result.model,
        parentModel: proposal.model,
        settings: parent.env.roots,
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
    changes && result.agent && result.agent !== proposal.agent
      ? result.agent
      : undefined;
  const resolvedAgentOverride = agentOverride
    ? findAgentByIdentifier(
        yield* resolveDelegationScopeAgents(
          parent.env.roots,
          parent.run.delegationAgentScope ?? undefined,
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
      `Cannot launch '${agentOverride}': it is not currently a visible agent (removed, renamed, or disabled since the proposal was shown). Re-propose the delegation.`,
      {
        summary: `Approved agent override '${agentOverride}' is not available`,
      },
    );
  }

  return {
    proposal: {
      ...proposal,
      ...(modelOverride && { model: modelOverride }),
      // Carry the override's resolved source alongside its name so launch
      // pins the exact entry the re-validation just resolved.
      ...(resolvedAgentOverride && {
        agent: resolvedAgentOverride.name,
        agentSource: resolvedAgentOverride.source,
      }),
    },
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
  } satisfies ApprovedDelegation;
});
