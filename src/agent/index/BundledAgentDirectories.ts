export const BUILTIN_WORKFLOW_AGENTS_DIR = 'agents' as const;
export const BUILTIN_TOOL_USE_AGENTS_DIR = 'tool_use_agents' as const;

export const BUNDLED_AGENT_DIRECTORY_NAMES = [
  BUILTIN_WORKFLOW_AGENTS_DIR,
  BUILTIN_TOOL_USE_AGENTS_DIR,
] as const;

export type BundledAgentDirectoryName =
  (typeof BUNDLED_AGENT_DIRECTORY_NAMES)[number];
