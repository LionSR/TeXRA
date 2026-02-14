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
  'propose_workflow',
  'propose_agent',
]);
