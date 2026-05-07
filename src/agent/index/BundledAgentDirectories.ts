export const BUNDLED_AGENT_DIRECTORY_NAMES = [
  'agents',
  'tool_use_agents',
] as const;

export type BundledAgentDirectoryName =
  (typeof BUNDLED_AGENT_DIRECTORY_NAMES)[number];
