/**
 * Proposal/approval handshake and agent/model resolution for delegation tools.
 *
 * If proposal bypass is active for a stream, launches immediately; otherwise
 * waits for user approval via `session.interactions` before executing.
 */

// Local imports
import type { AgentEntry } from '@agent/index/agentRegistry';
import { currentSession } from '@agent/runtime/SessionHandle';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import type { ProposalResult } from '@agent/runtime/HostInteractions';
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  AgentCategory,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentDelegationScope } from '@shared/schemas/agentRoster';
import type { ToolResult } from '@shared/schemas/toolResult';
import { proposalApprovals } from '@tools/approval';
import { errorResult, executed } from '@tools/core/result';
import { generateShortId } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  availableModelNamesFromOptions,
  getDelegationAgent,
  getDelegationAgents,
  selectDelegationModelFromAvailableNames,
} from './delegationAvailability';

// Local file imports
import { executeSubagent } from './subagentExecution';

const DEFAULT_DELEGATION_REJECTION_FEEDBACK = [
  'No feedback provided.',
  'Do not retry the same or equivalent delegation unless the user explicitly asks for it;',
  'continue directly with available context, or ask the user a clarifying question.',
].join(' ');

export async function selectAvailableDelegationModel(input: {
  readonly requestedModel?: string | null;
  readonly parentModel?: string | null;
}): Promise<string> {
  const modelOptions = await computeModelOptionsData();
  return selectDelegationModelFromAvailableNames({
    ...input,
    availableModels: availableModelNamesFromOptions(modelOptions),
  });
}

/**
 * Return the visible agent entry, or throw with the current visible list. The
 * caller carries the resolved `source` onto the proposal so launch pins the
 * exact `(source, name)` entry instead of re-resolving the bare name.
 */
export function requireVisibleAgent(
  category: AgentCategory,
  name: string,
  scope?: AgentDelegationScope,
): AgentEntry {
  const agent = getDelegationAgent(category, name, scope);
  if (agent) return agent;
  const available = getDelegationAgents(category, scope)
    .map((a) => a.name)
    .join(', ');
  throw new Error(
    `Unknown ${category} agent '${name}'. Available: ${available}`,
  );
}

/**
 * Resolve an agent across both Workflow and ToolUse rosters, returning the
 * first match and its category. Used by delegate_multi_agents where the outer
 * `agent` parameter accepts both kinds.
 */
export function requireWorkflowOrToolUseAgent(
  name: string,
  scope?: AgentDelegationScope,
): { agent: AgentEntry; category: AgentCategory } {
  let firstError: unknown;
  for (const category of [
    AgentCategory.Workflow,
    AgentCategory.ToolUse,
  ] as const) {
    try {
      return { agent: requireVisibleAgent(category, name, scope), category };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

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
  result: ProposalResult,
  agentName: string,
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): ToolResult | null {
  const echo = summarizeProposal(proposal);

  switch (result.action) {
    case 'reject': {
      const feedback = result.feedback?.trim();
      const feedbackLine = feedback
        ? `\nUser feedback: ${feedback}`
        : `\n${DEFAULT_DELEGATION_REJECTION_FEEDBACK}`;
      return errorResult(
        `Delegation to '${agentName}' was rejected.\nYour delegation was: ${echo}${feedbackLine}`,
        { summary: `User rejected delegation to '${agentName}'` },
      );
    }
    case 'setup':
      return executed(
        `Delegation opened for editing. The user will run it manually when ready.\nYour delegation was: ${echo}`,
        `User opened '${agentName}' for editing`,
      );
    case 'approve':
      return null;
  }
}

export interface DelegationProposalDecision {
  readonly result: ProposalResult;
  /** True only when the stream's proposal-bypass policy supplied approval. */
  readonly autoApproved: boolean;
}

/** Request the shared proposal decision, honoring the stream's bypass policy. */
export async function requestDelegationProposal(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
  streamId: StreamTabId,
): Promise<DelegationProposalDecision> {
  if (proposalApprovals().isBypassed(streamId)) {
    return { result: { action: 'approve' }, autoApproved: true };
  }

  // A run that can never present approval prompts withholds `requiresApproval`
  // tools from the model up front (resolveAgentTools), so a delegation tool
  // that still executes here was deliberately offered for unattended use —
  // delegate_multi_agents in a headless CLI run. The proposal is the
  // interactive review surface, not the security gate: proceed without one.
  // `autoApproved: false` keeps the child on inherited per-kind approval
  // state, so `--approval-policy never` still denies bash and edits
  // downstream.
  if (tryUseRunContext()?.approvalPromptsUnavailable === true) {
    return { result: { action: 'approve' }, autoApproved: false };
  }

  const interaction = currentSession().interactions.requestAgentProposal({
    proposalId: generateShortId(),
    streamId,
    ...proposal,
  });
  if (!interaction) {
    throw new Error('HostInteractions.requestAgentProposal is required');
  }
  return { result: await interaction, autoApproved: false };
}

/**
 * Shared proposal-or-bypass flow used by both delegate_workflow and delegate_agent.
 *
 * If proposal bypass is active for this stream, skips the proposal and launches immediately.
 * Otherwise, waits for user approval via the session's host interactions.
 */
export async function proposeAndExecute(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
  agentName: string,
  streamId: StreamTabId,
): Promise<ToolResult> {
  const decision = await requestDelegationProposal(proposal, streamId);
  if (decision.autoApproved) {
    // Preserve the approved delegation's edit grant explicitly on the child.
    // Proposal bypass can outlive the parent's ordinary edit-YOLO state.
    return executeSubagent(proposal, agentName, streamId, {
      approvalMeta: { autoApproved: true },
    });
  }

  const { result } = decision;

  const nonApproveResult = proposalResultToToolResult(
    result,
    agentName,
    proposal,
  );
  if (nonApproveResult) return nonApproveResult;

  // Every non-approve action returned above, so this is the approved path.
  // Route an approved model override through the same availability gate the
  // initial delegation uses (selectAvailableDelegationModel), so a model that
  // is unavailable in the active API mode fails synchronously here instead of
  // launching and then failing asynchronously. Re-selecting the proposed model
  // needs no re-check — it was already resolved when the proposal was built.
  let modelOverride: string | undefined;
  if (result.model && result.model !== proposal.model) {
    try {
      modelOverride = await selectAvailableDelegationModel({
        requestedModel: result.model,
        parentModel: proposal.model,
      });
    } catch (err) {
      return errorResult(
        `Cannot launch with model '${result.model}': ${toErrorMessage(err)} Re-propose the delegation.`,
        {
          summary: `Approved model override '${result.model}' is not available`,
        },
      );
    }
  }
  const agentOverride =
    result.agent && result.agent !== proposal.agent ? result.agent : undefined;
  const resolvedAgentOverride = agentOverride
    ? getDelegationAgent(proposal.agentCategory, agentOverride)
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
  const effectiveAgentName = resolvedAgentOverride?.name ?? agentName;
  return executeSubagent(effective, effectiveAgentName, streamId, {
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
}
