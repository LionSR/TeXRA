import { AgentCategory } from '../schemas/agent';

export const DELEGATE_MULTI_AGENTS_TOOL_NAME = 'delegate_multi_agents' as const;

const CANONICAL_DELEGATION_TOOL_NAMES = [
  'delegate_workflow',
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  'delegate_agent',
] as const;

export type CanonicalDelegationToolName =
  (typeof CANONICAL_DELEGATION_TOOL_NAMES)[number];

/**
 * Tools that delegate work to sub-agents.
 *
 * Defined in shared/ so both extension-host code and webview bundles
 * can import without pulling in tool class constructors.
 *
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(
  CANONICAL_DELEGATION_TOOL_NAMES,
);

/**
 * Maps each proposal-bearing delegation tool to the agent category it launches.
 * Single source of truth for routing raw delegation tool input to the matching
 * proposal schema.
 */
export const DELEGATION_TOOL_CATEGORY: Readonly<Record<string, AgentCategory>> =
  {
    delegate_workflow: AgentCategory.Workflow,
    delegate_agent: AgentCategory.ToolUse,
  };

/** True when any of the given tool names is a delegation tool. */
export function hasDelegationTool(
  toolNames: Iterable<string> | undefined,
): boolean {
  if (!toolNames) return false;
  for (const name of toolNames) {
    if (DELEGATION_TOOLS.has(name)) return true;
  }
  return false;
}
