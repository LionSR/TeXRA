/**
 * Proposal input registry for progress view.
 *
 * Stores typed proposal payloads by ID so they can be retrieved when the user
 * clicks the "Setup" link on a completed proposal log entry.
 *
 * Uses content-based hashing (like copyContentStore) so re-rendering the
 * same message produces the same ID — no memory leak on stream switches.
 */

import { z } from 'zod';

import {
  AGENT_CATEGORY,
  ToolConfigSchema,
  ToolUseAgentProposalSchema,
  WorkflowAgentProposalSchema,
  type AgentProposal,
} from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';

import { hashString } from './hashUtils';

/**
 * Lenient proposal schemas derived from the canonical shared schemas.
 * Add `.prefault()` defaults for fields the LLM may omit in tool input.
 */
const LenientToolUseProposalSchema = ToolUseAgentProposalSchema.extend({
  model: z.string().prefault('gemini31p'),
});

const LenientWorkflowProposalSchema = WorkflowAgentProposalSchema.extend({
  model: z.string().prefault('gemini31p'),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFile: z.string().nullable().prefault(null),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFile: z.string().nullable().prefault(null),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFile: z.string().nullable().prefault(null),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  useMultipleOutputs: z.boolean().prefault(false),
  toolConfig: ToolConfigSchema,
});

const proposalInputStore = new Map<string, AgentProposal>();

function parseProposalInput(
  input: unknown,
  toolName: string,
): AgentProposal | null {
  const spread = isPlainObject(input) ? input : {};

  if (toolName === 'delegate_agent' || toolName === 'propose_agent') {
    const result = LenientToolUseProposalSchema.safeParse({
      agentCategory: AGENT_CATEGORY.TOOL_USE,
      ...spread,
    });
    return result.success ? result.data : null;
  }

  if (toolName === 'delegate_workflow' || toolName === 'propose_workflow') {
    const result = LenientWorkflowProposalSchema.safeParse({
      agentCategory: AGENT_CATEGORY.WORKFLOW,
      ...spread,
    });
    return result.success ? result.data : null;
  }

  return null;
}

/**
 * Register proposal input and return a stable ID for lookup.
 */
export function registerProposalInput(
  input: unknown,
  toolName: string,
): string | null {
  const proposal = parseProposalInput(input, toolName);
  if (!proposal) return null;

  const serialized = JSON.stringify(proposal);
  const id = `proposal:${serialized.length}:${hashString(serialized)}`;
  if (!proposalInputStore.has(id)) {
    proposalInputStore.set(id, proposal);
  }
  return id;
}

/**
 * Retrieve proposal input by ID.
 */
export function getProposalInput(id: string): AgentProposal | undefined {
  return proposalInputStore.get(id);
}

/**
 * Clear all proposal input entries (called on stream delete / delete-all).
 */
export function clearProposalInputStore(): void {
  proposalInputStore.clear();
}
