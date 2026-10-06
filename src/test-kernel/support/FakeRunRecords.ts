import { Effect } from 'effect';
import type { getRunRecords } from '@agent/storage/runRecords';

/** Native record fixture for suites that replace the database reader boundary. */
export function createFakeRunRecords(
  overrides: Partial<ReturnType<typeof getRunRecords>> = {},
): ReturnType<typeof getRunRecords> {
  return {
    exists: () => Effect.succeed(false),
    readRunRecord: () => Effect.succeed(null),
    isOpened: () => Effect.succeed(false),
    readBinding: () => Effect.succeed(null),
    readConfig: () => Effect.succeed(null),
    readReport: () => Effect.succeed(null),
    readWorkspaceFiles: () => Effect.succeed([]),
    readResultMeta: () => Effect.succeed(null),
    readRunEnd: () => Effect.succeed(null),
    readResult: () => Effect.succeed(null),
    writeResultMeta: () => Effect.void,
    ...overrides,
  };
}
