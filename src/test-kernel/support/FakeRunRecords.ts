import { Effect } from 'effect';
import type { getRunRecords } from '@agent/storage/runRecords';

/** Native record fixture for suites that replace the database reader boundary. */
export function createFakeRunRecords(
  overrides: Partial<ReturnType<typeof getRunRecords>> = {},
): ReturnType<typeof getRunRecords> {
  return {
    exists: () => Effect.succeed(false),
    isRemoved: () => Effect.succeed(false),
    countActivations: () => Effect.succeed(1),
    readRunRecord: () => Effect.succeed(null),
    readConfig: () => Effect.succeed(null),
    readReport: () => Effect.succeed(null),
    readWorkflow: () => Effect.succeed(null),
    readWorkspaceFiles: () => Effect.succeed([]),
    readResultMeta: () => Effect.succeed(null),
    readRunEnd: () => Effect.succeed(null),
    writeRunRecord: () => Effect.void,
    writeReport: () => Effect.void,
    clearReport: () => Effect.void,
    writeWorkspaceFiles: () => Effect.void,
    writeResultMeta: () => Effect.void,
    ...overrides,
  };
}
