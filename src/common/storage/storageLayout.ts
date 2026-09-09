/** Root collection names shared by storage providers and persisted stores. */
export const WORKSPACE_STORAGE_LAYOUT = Object.freeze({
  memory: 'memories',
  runs: 'executions',
  executionLeases: 'executionLeases',
  original: 'original',
} as const);

/** Global (non-workspace-scoped) storage directory names, shared across hosts. */
export const CUSTOM_AGENTS_STORAGE_DIR = 'custom_agents';
