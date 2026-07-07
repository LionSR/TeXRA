import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';

/** Minimal in-memory stand-in for ExecutionKVStore; only read/write/getExecutionId are exercised by PersistedFlow. */
export function createFakeKv(executionId = 'test-exec-0001'): ExecutionKVStore {
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
    readMeta: async () => null,
    readConfig: async () => null,
    readReport: async () => null,
    readTodos: async () => [],
    todosModifiedAt: async () => undefined,
    readConversation: async () => null,
    readWorkspaceFiles: async () => [],
    readChildren: async () => [],
    readResultMeta: async () => null,
    writeMeta: async () => {},
    writeConfig: async () => {},
    writeReport: async () => {},
    writeTodos: async () => {},
    writeConversation: async () => {},
    writeWorkspaceFiles: async () => {},
    writeChild: async () => {},
    writeResultMeta: async () => {},
  } as unknown as ExecutionKVStore;
}
