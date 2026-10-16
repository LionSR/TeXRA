/** Root collection names shared by storage providers and persisted stores. */
export const WORKSPACE_STORAGE_LAYOUT = Object.freeze({
  memory: 'memories',
  runs: 'executions',
  original: 'original',
} as const);

/** Global (non-workspace-scoped) storage directory names, shared across hosts. */
export const CUSTOM_AGENTS_STORAGE_DIR = 'custom_agents';

/** The MCP config file's name inside a TeXRA storage root. */
export const MCP_CONFIG_FILE_NAME = 'mcp.json';
