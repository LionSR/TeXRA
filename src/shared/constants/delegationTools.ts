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
  'delegate_agent',
  'resume_agent',
  'propose_workflow',
  'propose_agent',
]);

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
