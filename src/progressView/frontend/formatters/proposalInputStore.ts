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
  model: z.string().prefault('gemini3p'),
  mode: z.enum(['sync', 'async']).catch('sync'),
});

const LenientWorkflowProposalSchema = WorkflowAgentProposalSchema.extend({
  model: z.string().prefault('gemini3p'),
  mode: z.enum(['sync', 'async']).catch('sync'),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFile: z.string().nullable().prefault(null),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFile: z.string().nullable().prefault(null),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFile: z.string().nullable().prefault(null),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  useMultipleOutputs: z.boolean().prefault(false),
});

export interface StoredProposal {
  proposal: AgentProposal;
}

const proposalInputStore = new Map<string, StoredProposal>();

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

function buildId(proposal: AgentProposal): string {
  const serialized = JSON.stringify(proposal);
  return `proposal:${serialized.length}:${hashString(serialized)}`;
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

  const id = buildId(proposal);
  if (!proposalInputStore.has(id)) {
    proposalInputStore.set(id, { proposal });
  }
  return id;
}

/**
 * Retrieve proposal input by ID.
 */
export function getProposalInput(id: string): StoredProposal | undefined {
  return proposalInputStore.get(id);
}
