/** The tool that runs a named agent as a child of the calling run. */
export const AGENT_TOOL_NAME = 'agent' as const;

/** The tool that runs a named agent's document task as a child. */
export const DOCUMENT_TASK_TOOL_NAME = 'document_task' as const;

/** True when the given tool names include the delegation tool: an agent
 *  that names it is an orchestrator. */
export function hasDelegationTool(
  toolNames: Iterable<string> | undefined,
): boolean {
  if (!toolNames) return false;
  for (const name of toolNames) if (name === AGENT_TOOL_NAME) return true;
  return false;
}
