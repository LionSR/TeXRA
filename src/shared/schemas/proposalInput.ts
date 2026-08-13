/**
 * Reconstruct a canonical {@link AgentProposal} from the raw delegation/proposal
 * tool input captured in a progress-view log entry.
 *
 * The progress view's "Setup" link replays a past delegation into the main view.
 * To do that it must rebuild the typed proposal from the raw tool-call input that
 * was logged. This parser owns that reconstruction.
 *
 * It lives in the schema layer (not the renderer) because it encodes domain
 * knowledge rather than presentation: which delegation tools map to which agent
 * category and the `extractFigures` / `extractTikz` shorthand → `toolConfig`
 * mapping. The renderer-side
 * `proposalInputStore` is a thin registry over this parser.
 *
 * The schemas here are deliberately lenient: the LLM may omit fields the
 * canonical proposal schema requires, so display-only defaults
 * ({@link DEFAULT_AGENT_MODEL}, empty file lists) are layered on top of the
 * shared proposal schemas.
 *
 * Note: at runtime `DelegationTools.execute` also inherits extraction flags from
 * the parent agent's `toolConfig` when omitted. That parent context is not
 * available here, so the reconstruction reflects only what the tool input
 * explicitly carried.
 */
import { z } from 'zod';

import { isObject } from '@utils/core';

import { DEFAULT_AGENT_MODEL } from '../constants/providers';
import { DELEGATION_TOOL_CATEGORY } from '../constants/delegationTools';
import { AgentCategory } from './agent';
import { fileListFields } from './fileFields';
import {
  ToolUseAgentProposalSchema,
  WorkflowAgentProposalSchema,
  type AgentProposal,
} from './prompts';

/**
 * Lenient proposal schemas derived from the canonical shared schemas.
 * Add display-only defaults for fields the LLM may omit in tool input.
 */
const LenientToolUseProposalSchema = ToolUseAgentProposalSchema.extend({
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
});

const LenientWorkflowProposalSchema = WorkflowAgentProposalSchema.extend({
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  ...fileListFields,
  // toolConfig is inherited from WorkflowAgentProposalSchema (via
  // WorkflowSpecificFieldsSchema) and already object-prefaulted — no override.
});

/**
 * Fold the `extractFigures` / `extractTikz` delegation shorthand into the
 * canonical `toolConfig.autoExtract*` flags. Mirrors the runtime mapping in
 * `DelegationTools.execute`, but only sets a flag the input explicitly carried
 * (absent stays undefined so the lenient schema's prefault applies).
 */
function extractionShorthandToolConfig(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const existing = isObject(source.toolConfig) ? source.toolConfig : {};
  const overrides: Record<string, unknown> = { ...existing };
  if (source.extractFigures != null) {
    overrides.autoExtractFigure = Boolean(source.extractFigures);
  }
  if (source.extractTikz != null) {
    overrides.autoExtractTikzFigure = Boolean(source.extractTikz);
  }
  return overrides;
}

/**
 * Parse raw delegation/proposal tool input into a canonical {@link AgentProposal},
 * or `null` when the tool is not proposal-bearing or the input fails validation.
 */
export function parseDelegationToolInput(
  input: unknown,
  toolName: string,
): AgentProposal | null {
  // Own-property guard: toolName derives from untrusted logged input, so a
  // value like 'constructor' must not resolve to an inherited Object member.
  const category = Object.hasOwn(DELEGATION_TOOL_CATEGORY, toolName)
    ? DELEGATION_TOOL_CATEGORY[toolName]
    : undefined;
  if (!category) return null;

  const spread = isObject(input) ? input : {};

  if (category === AgentCategory.ToolUse) {
    return LenientToolUseProposalSchema.nullable()
      .catch(null)
      .parse({
        agentCategory: AgentCategory.ToolUse,
        ...spread,
      });
  }

  return LenientWorkflowProposalSchema.nullable()
    .catch(null)
    .parse({
      agentCategory: AgentCategory.Workflow,
      ...spread,
      toolConfig: extractionShorthandToolConfig(spread),
    });
}
