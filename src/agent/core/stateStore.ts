/**
 * Platform-agnostic state store facade for the agent core.
 *
 * Provides a KV interface matching vscode.Memento. Default: in-memory Map.
 * VS Code calls `setGlobalState()` / `setWorkspaceState()` at activation.
 */

export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

// ---------------------------------------------------------------------------
// In-memory default (for CLI / tests)
// ---------------------------------------------------------------------------

function createMemoryStore(): StateStore {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      const v = map.get(key);
      return v !== undefined ? (v as T) : (defaultValue as T);
    },
    async update(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// Settable stores
// ---------------------------------------------------------------------------

let global: StateStore = createMemoryStore();
let workspace: StateStore = createMemoryStore();

export function setGlobalState(store: StateStore): void {
  global = store;
}
export function setWorkspaceState(store: StateStore): void {
  workspace = store;
}

/** Global state (cross-workspace). */
export function getGlobalState(): StateStore {
  return global;
}

/** Workspace-scoped state. */
export function getWorkspaceState(): StateStore {
  return workspace;
}

// ---------------------------------------------------------------------------
// Convenience readers (previously in @utils/config/constants.ts)
// ---------------------------------------------------------------------------

const MEMORY_ENABLED_KEY = 'texra.memory.enabled';
const DEFAULT_TOOL_USE_MEMORY_ENABLED = true;

/** Whether the memory tool is enabled for tool-use sessions. */
export function getToolUseMemoryEnabled(): boolean {
  return (
    global.get<boolean>(MEMORY_ENABLED_KEY, DEFAULT_TOOL_USE_MEMORY_ENABLED) ??
    DEFAULT_TOOL_USE_MEMORY_ENABLED
  );
}
