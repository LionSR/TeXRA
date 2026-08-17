/**
 * Marker file written beside a workspace storage bucket, recording which
 * workspace path the bucket belongs to.
 */
export const WORKSPACE_SIDECAR_FILE = '_workspace.json';

/** Root collection names shared by storage providers and persisted stores. */
export const WORKSPACE_STORAGE_LAYOUT = Object.freeze({
  memory: 'memories',
  runs: 'executions',
  executionLeases: 'executionLeases',
  executionLocks: 'executionLocks',
  legacyRuns: 'taskRuns',
  streamData: 'streamData',
  streamLogs: 'streamLogs',
  original: 'original',
} as const);

/** Global (non-workspace-scoped) storage directory names, shared across hosts. */
export const CUSTOM_AGENTS_STORAGE_DIR = 'custom_agents';
export const EXTERNAL_INQUIRY_THREADS_DIR = 'ei_threads';
