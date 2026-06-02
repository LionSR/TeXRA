const AGENT_LOOKUP_HINT =
  'Use `texra agents list` for visible starter agents, or pass a known launchable agent name from a team preset.';

export const AGENT_NAME_DESCRIPTION =
  'Agent name from `texra agents list` or a known launchable agent name';

export const TOOL_USE_AGENT_NAME_DESCRIPTION =
  'Tool-use agent name from `texra agents list` or a known launchable agent name';

export function missingAgentMessage(name: string): string {
  return `Agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

export function missingToolUseAgentMessage(name: string): string {
  return `Tool-use agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}
