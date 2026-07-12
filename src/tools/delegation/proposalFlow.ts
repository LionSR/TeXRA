/**
 * Proposal/approval handshake and agent/model resolution for delegation tools.
 *
 * If proposal bypass is active for a stream, launches immediately; otherwise
 * waits for user approval via `session.interactions` before executing.
 */

// Third-party imports
import { nanoid } from 'nanoid';

// Local imports - agent
import {
  getVisibleAgent,
  getVisibleAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { currentSession } from '@agent/runtime/SessionHandle';
import type { ProposalResult } from '@agent/runtime/HostInteractions';

// Local imports - model
import { computeModelOptionsData } from '@model/computeModelOptions';

// Local imports - tools
import {
  AgentCategory,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import {
  isApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';
import {
  availableModelNamesFromOptions,
  selectDelegationModelFromAvailableNames,
} from '@tools/delegationModelAvailability';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - delegation
import { executeSubagent } from './subagentExecution';

const DEFAULT_DELEGATION_REJECTION_FEEDBACK = [
  'No feedback provided.',
  'Do not retry the same or equivalent delegation unless the user explicitly asks for it;',
  'continue directly with available context, or ask the user a clarifying question.',
].join(' ');

export async function selectAvailableDelegationModel(input: {
  readonly requestedModel?: string | null;
  readonly parentModel?: string | null;
  readonly agentCategory: AgentCategory;
}): Promise<string> {
  const modelOptions = await computeModelOptionsData(undefined, undefined, {
    agentCategory: input.agentCategory,
  });
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
): AgentEntry {
  const agent = getVisibleAgent(category, name);
  if (agent) return agent;
  const available = getVisibleAgents(category)
    .map((a) => a.name)
    .join(', ');
  throw new Error(
    `Unknown ${category} agent '${name}'. Available: ${available}`,
  );
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
  const instrPreview =
    proposal.instruction.length > 120
      ? `${proposal.instruction.slice(0, 117)}...`
      : proposal.instruction;
  parts.push(`Instruction: "${instrPreview}"`);
  return parts.join(', ');
}

/** Convert proposal result to ToolResult. Returns null if approved. */
function proposalResultToToolResult(
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
      return {
        status: 'error',
        summary: `User rejected delegation to '${agentName}'`,
        error: `Delegation to '${agentName}' was rejected.\nYour delegation was: ${echo}${feedbackLine}`,
      };
    }
    case 'timeout':
      return {
        status: 'error',
        summary: `Delegation to '${agentName}' timed out`,
        error: `Delegation to '${agentName}' timed out waiting for user approval.\nYour delegation was: ${echo}`,
      };
    case 'setup':
      return {
        status: 'executed',
        summary: `User opened '${agentName}' for editing`,
        output: `Delegation opened for editing. The user will run it manually when ready.\nYour delegation was: ${echo}`,
      };
    case 'approve':
      return null;
  }
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
  if (proposalApprovals().isBypassed(streamId)) {
    return executeSubagent(proposal, agentName, streamId, {
      enableYoloOnChild: true,
      approvalMeta: { autoApproved: true },
    });
  }

  const proposalId = nanoid();

  const interaction = currentSession().interactions.requestAgentProposal({
    proposalId,
    streamId,
    ...proposal,
  });
  if (!interaction) {
    throw new Error('HostInteractions.requestAgentProposal is required');
  }
  const result = await interaction;

  const nonApproveResult = proposalResultToToolResult(
    result,
    agentName,
    proposal,
  );
  if (nonApproveResult) return nonApproveResult;

  // At this point result.action === 'approve' (all other cases returned above).
  if (result.action !== 'approve') {
    throw new Error(`Unexpected non-approve proposal result: ${result.action}`);
  }
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
        agentCategory: proposal.agentCategory,
      });
    } catch (err) {
      return {
        status: 'error',
        summary: `Approved model override '${result.model}' is not available`,
        error: `Cannot launch with model '${result.model}': ${toErrorMessage(err)} Re-propose the delegation.`,
      };
    }
  }
  const agentOverride =
    result.agent && result.agent !== proposal.agent ? result.agent : undefined;
  const resolvedAgentOverride = agentOverride
    ? getVisibleAgent(proposal.agentCategory, agentOverride)
    : undefined;

  // Re-validate against the current registry — between proposal display and
  // approval the agent may have been removed/renamed, or the approval could
  // carry a malformed value. Fail fast so the orchestrator sees the problem
  // synchronously instead of after an async launch.
  if (agentOverride && !resolvedAgentOverride) {
    return {
      status: 'error',
      summary: `Approved agent override '${agentOverride}' is not available`,
      error: `Cannot launch '${agentOverride}': it is not currently a visible ${proposal.agentCategory} agent (removed, renamed, or disabled since the proposal was shown). Re-propose the delegation.`,
    };
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
    enableYoloOnChild: isApprovalBypassedForStream(streamId),
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
