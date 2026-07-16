/** Root collection names shared by storage providers and persisted stores. */
export const WORKSPACE_STORAGE_LAYOUT = {
  memory: 'memories',
  runs: 'executions',
  executionLeases: 'executionLeases',
  legacyRuns: 'taskRuns',
  streamData: 'streamData',
  streamLogs: 'streamLogs',
  original: 'original',
} as const;
