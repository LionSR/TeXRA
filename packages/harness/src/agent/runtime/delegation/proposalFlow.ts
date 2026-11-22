/**
 * Proposal/approval handshake and agent/model resolution for delegation tools.
 *
 * If proposal bypass is active for a stream, launches immediately; otherwise
 * waits for user approval through the session's requests before executing.
 */

// Third-party imports
import { Context, type Deferred, Effect, Exit } from 'effect';

// Local imports
import type { RunToolCall } from '@agent/runtime/RunCall';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { recordedDecision } from '@agent/runtime/requests';
import { programOf, programOrigin, type ProgramOrigin } from '@shared/schemas';
import type {
  AgentProposal,
  DecisionOf,
  ProposalEdit,
  RefusalDecision,
  RequestDecision,
  ToolResult,
} from '@shared/schemas';
import type {
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { Approvals, type RunHistoryRefused } from '@shared/session/runHistory';
import { errorResult } from '@tools/core/result';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { selectAvailableDelegationModel } from './delegationAvailability';

// Local file imports
import type { ApprovalMeta, DelegatedChildApproval } from './subagentRun';

const DEFAULT_DELEGATION_REJECTION_FEEDBACK = [
  'No feedback provided.',
  'Do not retry the same or equivalent delegation unless the user explicitly asks for it;',
  'continue directly with available context, or ask the user a clarifying question.',
].join(' ');

/** Build a concise summary of proposal parameters for rejection echo. */
function summarizeProposal(proposal: AgentProposal): string {
  const parts = [`Agent: ${proposal.label}`, `Model: ${proposal.model}`];
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

/** A declined proposal, as the call's result. */
function proposalRefusalResult(
  refusal: RefusalDecision,
  proposal: AgentProposal,
): ToolResult {
  const { label: agentName } = proposal;
  const echo = summarizeProposal(proposal);
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
  readonly result: DecisionOf<'proposal'>;
  /** How the child's own grants record this approval (see
   *  {@link DelegatedChildApproval}); `inherit` unless the run's proposal
   *  bypass supplied it. */
  readonly childApproval: DelegatedChildApproval;
}

type ProposalRequestError =
  | DatabaseAggregateClosed
  | DatabaseReadFailed
  | DatabaseWriteFailed
  | RunHistoryRefused;

/** The key of the request the `agent` calls of one script share
 *  (`ScriptScope.shared`): the `ask` {@link decideDelegation} takes. */
export const AgentRequest = Context.Service<
  Deferred.Deferred<RequestDecision, ProposalRequestError>
>('@texra-ai/worldline/agent/AgentRequest');

/** How a child records an approval the run's delegated-work grant gave. */
const GRANTED_CHILD = {
  goal: 'goal-approved',
  human: 'auto-approved',
} as const;

/** Request the shared proposal decision, honoring the run's bypass policy.
 *  `ask` presents it in place of this call's own proposal request: the
 *  calls of one script share one request (`agent`). */
const requestDelegationProposal = Effect.fn('requestDelegationProposal')(
  function* (
    proposal: AgentProposal,
    parent: RunToolCall,
    ask?: Effect.Effect<RequestDecision, ProposalRequestError, SessionServices>,
  ): Effect.fn.Return<
    DelegationProposalDecision,
    ProposalRequestError,
    SessionServices
  > {
    const { runId, config } = parent.run;
    const approvals = yield* Approvals;
    const { hook } = parent;
    // The delegation of a program a plugin ships is approved unless a hook
    // asked for it; one the agent wrote for itself asks as its script would.
    const program = programOf(config);
    const approved =
      program !== null &&
      (
        { listed: true, installed: true, own: false } satisfies Record<
          ProgramOrigin,
          boolean
        >
      )[programOrigin(program.name)];
    if (approved && hook !== 'ask')
      return { result: { action: 'approve' }, childApproval: 'inherit' };
    const answer = approvals.permission(runId, 'proposal', hook);
    if (answer !== 'allow' && answer !== 'ask')
      return { result: answer, childApproval: 'inherit' };
    if (answer === 'allow') {
      // Under `yolo` alone the child inherits, so its bash and edits still
      // gate; the run's delegated-work grant approves them too.
      const granted = approvals.bypass(runId, 'superYolo');
      const childApproval = granted ? GRANTED_CHILD[granted] : 'inherit';
      return { result: { action: 'approve' }, childApproval };
    }
    // The script's shared request may answer from its recorded row.
    if (ask !== undefined) {
      const result = yield* recordedDecision({ kind: 'proposal' }, yield* ask);
      return { result, childApproval: 'inherit' };
    }

    // A call made under a run opens its requests through the loop's door.
    const { requests } = parent;
    const { decision: result } = yield* requests.open({
      kind: 'proposal',
      data: { requestId: requests.nextId(), runId, ...proposal },
    });
    return { result, childApproval: 'inherit' };
  },
);

/** The fields an approval changed from the proposal, other than its
 *  model: the instruction and the file lists. */
function formEdits(
  proposal: AgentProposal,
  edit: ProposalEdit,
): Partial<AgentProposal> {
  const changed = (
    edited: readonly string[] | null | undefined,
    proposed: readonly string[],
  ): edited is readonly string[] =>
    edited != null &&
    (edited.length !== proposed.length ||
      edited.some((file, index) => file !== proposed[index]));
  const { instruction, inputFiles, contextFiles, mediaFiles } = edit;
  return {
    ...(instruction != null &&
      instruction !== proposal.instruction && { instruction }),
    ...(changed(inputFiles, proposal.inputFiles) && {
      inputFiles: [...inputFiles],
      outputFiles: [],
    }),
    ...(changed(contextFiles, proposal.contextFiles) && {
      contextFiles: [...contextFiles],
    }),
    ...(changed(mediaFiles, proposal.mediaFiles) && {
      mediaFiles: [...mediaFiles],
    }),
  };
}

/** How an approved delegation launches: the proposal with the model the
 *  approval finished on, and how it was approved. */
interface ApprovedDelegation {
  readonly proposal: AgentProposal;
  readonly approvalMeta: ApprovalMeta;
}

/**
 * The proposal-or-bypass decision every delegation takes, and the model an
 * approval changed, re-checked against the live list: a declined or
 * unusable approval is the call's result, an approval is what launches. A
 * request the calls of one script share (`ask`) approves the script, not
 * one call's model, so it changes none.
 */
export const decideDelegation = Effect.fn('decideDelegation')(function* (
  parent: RunToolCall,
  proposal: AgentProposal,
  ask?: Effect.Effect<RequestDecision, ProposalRequestError, SessionServices>,
) {
  const decision = yield* requestDelegationProposal(proposal, parent, ask);
  if (decision.childApproval !== 'inherit') {
    // Preserve the approved delegation's edit grant explicitly on the child.
    // Proposal bypass can outlive the parent's ordinary edit-YOLO state.
    return {
      proposal,
      approvalMeta: { childApproval: decision.childApproval },
    } satisfies ApprovedDelegation;
  }

  const { result } = decision;
  if (result.action !== 'approve')
    return proposalRefusalResult(result, proposal);

  // Route an approved model override through the same availability gate the
  // initial delegation uses (selectAvailableDelegationModel), so an unavailable
  // model fails synchronously here instead of launching and then failing
  // asynchronously. Re-selecting the proposed model needs no re-check — it was
  // already resolved when the proposal was built.
  const edit = ask === undefined ? result.edit : undefined;
  let modelOverride: string | undefined;
  if (edit?.model && edit.model !== proposal.model) {
    const modelExit = yield* Effect.exit(
      selectAvailableDelegationModel({
        requestedModel: edit.model,
        parentModel: proposal.model,
        settings: parent.env.roots,
      }),
    );
    if (Exit.isFailure(modelExit)) {
      return errorResult(
        `Cannot launch with model '${edit.model}': ${toErrorMessage(modelExit.cause)} Re-propose the delegation.`,
        {
          summary: `Approved model override '${edit.model}' is not available`,
        },
      );
    }
    modelOverride = modelExit.value.model;
  }

  // What the person changed in the launch form besides the model.
  // A changed input list drops the proposal's outputs: they were named for
  // its inputs, and a program names its own for the new ones.
  const edited = edit ? formEdits(proposal, edit) : {};
  return {
    proposal: {
      ...proposal,
      ...edited,
      ...(modelOverride && { model: modelOverride }),
    },
    approvalMeta: {
      childApproval: 'inherit',
      ...(modelOverride && {
        model: { chosen: modelOverride, proposed: proposal.model },
      }),
    },
  } satisfies ApprovedDelegation;
});
