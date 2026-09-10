import { Effect } from 'effect';
import type {
  getRunRecords,
  RunKVStore,
} from '@agent/storage/RunKVStore';
import type { RunId } from '@shared/schemas';

/**
 * In-memory stand-in for the store `getRunStore()` returns. The generic
 * key/value half is real; the typed accessors answer empty by default and each
 * suite overrides only the ones it drives. Covering the whole interface is the
 * point: a partial object literal per suite silently rots as `RunKVStore`
 * grows, and calling an unstubbed accessor there throws a bare `TypeError`.
 */
export function createFakeKv(
  runId = 'test-exec-0001' as RunId,
  overrides: Partial<RunKVStore> = {},
): RunKVStore {
  const store = new Map<string, unknown>();
  return {
    read: async <T>(key: string) => store.get(key) as T | undefined,
    write: async <T>(key: string, value: T) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    exists: async (key: string) => store.has(key),
    listKeys: async () => [...store.keys()],
    clear: async () => store.clear(),
    getRunId: () => runId,
    readTurnState: async () => null,
    writeTurnState: async () => {},
    ...overrides,
  };
}

/** Native record fixture for suites that replace the database reader boundary. */
export function createFakeRunRecords(
  overrides: Partial<ReturnType<typeof getRunRecords>> = {},
): ReturnType<typeof getRunRecords> {
  return {
    readMeta: () => Effect.succeed(null),
    readRunRecord: () => Effect.succeed(null),
    readConfig: () => Effect.succeed(null),
    readReport: () => Effect.succeed(null),
    readWorkspaceFiles: () => Effect.succeed([]),
    readResultMeta: () => Effect.succeed(null),
    writeRunRecord: () => Effect.void,
    writeReport: () => Effect.void,
    clearReport: () => Effect.void,
    writeWorkspaceFiles: () => Effect.void,
    writeResultMeta: () => Effect.void,
    ...overrides,
  };
}
