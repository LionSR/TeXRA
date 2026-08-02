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
  streamData: 'streamData',
  streamLogs: 'streamLogs',
  original: 'original',
} as const);
