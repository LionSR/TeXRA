import { Effect } from 'effect';
import type {
  getExecutionRecords,
  ExecutionKVStore,
} from '@agent/storage/ExecutionKVStore';
import type { ExecutionId } from '@shared/schemas';

/**
 * In-memory stand-in for the store `getExecutionStore()` returns. The generic
 * key/value half is real; the typed accessors answer empty by default and each
 * suite overrides only the ones it drives. Covering the whole interface is the
 * point: a partial object literal per suite silently rots as `ExecutionKVStore`
 * grows, and calling an unstubbed accessor there throws a bare `TypeError`.
 */
export function createFakeKv(
  executionId = 'test-exec-0001' as ExecutionId,
  overrides: Partial<ExecutionKVStore> = {},
): ExecutionKVStore {
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
    getExecutionId: () => executionId,
    readTurnState: async () => null,
    writeTurnState: async () => {},
    ...overrides,
  };
}

/** Native record fixture for suites that replace the database reader boundary. */
export function createFakeExecutionRecords(
  overrides: Partial<ReturnType<typeof getExecutionRecords>> = {},
): ReturnType<typeof getExecutionRecords> {
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
