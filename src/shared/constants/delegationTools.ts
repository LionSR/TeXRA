import { AgentCategory } from '../schemas/agent';

export const DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME =
  'delegate_workflow_script' as const;

/**
 * Tools that delegate work to sub-agents.
 *
 * Defined in shared/ so both extension-host code and webview bundles
 * can import without pulling in tool class constructors.
 *
 * Includes legacy aliases for historical log entries.
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  'delegate_workflow',
  DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  'delegate_agent',
  'resume_agent',
  'propose_workflow',
  'propose_agent',
]);

/**
 * Maps each proposal-bearing delegation tool to the agent category it launches.
 * `resume_agent` is intentionally absent — it carries no proposal payload to
 * reconstruct. Single source of truth for routing raw delegation tool input to
 * the matching proposal schema.
 */
export const DELEGATION_TOOL_CATEGORY: Readonly<Record<string, AgentCategory>> =
  {
    delegate_workflow: AgentCategory.Workflow,
    propose_workflow: AgentCategory.Workflow,
    delegate_agent: AgentCategory.ToolUse,
    propose_agent: AgentCategory.ToolUse,
  };

/** Delegation tools whose descriptions receive live roster/model annotations. */
export const DELEGATION_AVAILABILITY_CATEGORY: Readonly<
  Record<string, AgentCategory>
> = {
  ...DELEGATION_TOOL_CATEGORY,
  [DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME]: AgentCategory.Workflow,
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
