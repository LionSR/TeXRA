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
