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
  migrateLegacyContextFileFields,
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
  contextFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  toolConfig: ToolConfigSchema,
});

const MAX_STORE_SIZE = 500;
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
    const migrated = migrateLegacyContextFileFields(spread) as Record<
      string,
      unknown
    >;
    // Map extraction shorthand flags into toolConfig.
    // Note: at runtime, DelegationTools.execute also inherits flags from the
    // parent agent's toolConfig when omitted. That inheritance can't be
    // replicated here (no access to parent context), so the store reflects
    // only what the LLM explicitly requested.
    const extractFigures =
      migrated.extractFigures != null
        ? Boolean(migrated.extractFigures)
        : undefined;
    const extractTikz =
      migrated.extractTikz != null ? Boolean(migrated.extractTikz) : undefined;
    const existingToolConfig = isPlainObject(migrated.toolConfig)
      ? migrated.toolConfig
      : {};
    const toolConfig = {
      ...existingToolConfig,
      ...(extractFigures !== undefined && {
        autoExtractFigure: extractFigures,
      }),
      ...(extractTikz !== undefined && {
        autoExtractTikzFigure: extractTikz,
      }),
    };

    const result = LenientWorkflowProposalSchema.safeParse({
      agentCategory: AGENT_CATEGORY.WORKFLOW,
      ...migrated,
      toolConfig,
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
    if (proposalInputStore.size >= MAX_STORE_SIZE) {
      // Evict oldest entry (first key in insertion order).
      const oldest = proposalInputStore.keys().next().value;
      if (oldest !== undefined) proposalInputStore.delete(oldest);
    }
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
