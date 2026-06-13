const AGENT_LOOKUP_HINT =
  'Use `texra agents list` for visible starter agents, or pass a known launchable agent name from a team preset.';
const MULTI_AGENT_PRESET_LOOKUP_HINT =
  'Use `texra multi-agent list` for available team presets, then run `texra multi-agent inspect <preset>` to check a team before launch.';

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

export function missingMultiAgentPresetMessage(name: string): string {
  return `Multi-agent preset not found: ${name}. ${MULTI_AGENT_PRESET_LOOKUP_HINT}`;
}
