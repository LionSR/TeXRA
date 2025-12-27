/**
 * VS Code settings query constants for extension configuration.
 */

export const SETTINGS_QUERY = {
  EXTENSION: '@ext:texra-ai.texra',
  WORKFLOW_AGENTS: '@ext:texra-ai.texra texra.agents',
  TOOL_USE_AGENTS: '@ext:texra-ai.texra texra.toolUseAgents',
  MODELS: '@ext:texra-ai.texra models',
  AGENT_DIRECTORY: '@ext:texra-ai.texra explorer.agentsDirectory',
} as const;
