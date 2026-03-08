/**
 * Platform-agnostic state reader/writer.
 *
 * Provides read/write access to global and workspace state from VS Code-free
 * zones (src/agent/, src/model/, src/tools/, etc.).
 *
 * The real implementation is injected at activation time via `setStateBridge()`,
 * called from extension.ts. Before injection, reads return the supplied default
 * and writes are no-ops.
 */

/**
 * Minimal state accessor interface, matching the VS Code Memento API shape.
 */
export interface StateAccessor {
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** No-op state accessor used before injection. */
const noopAccessor: StateAccessor = {
  get<T>(_key: string, defaultValue?: T): T {
    return defaultValue as T;
  },
  update: async () => {},
};

let _globalState: StateAccessor = noopAccessor;
let _workspaceState: StateAccessor = noopAccessor;

/**
 * Register platform-specific state accessors.
 * Called once from extension.ts during activation.
 */
export function setStateBridge(
  global: StateAccessor,
  workspace: StateAccessor,
): void {
  _globalState = global;
  _workspaceState = workspace;
}

/** Platform-agnostic global state reader. */
export const globalState: StateAccessor = {
  get<T>(key: string, defaultValue?: T): T {
    return _globalState.get(key, defaultValue as T);
  },
  update: (key: string, value: unknown) => _globalState.update(key, value),
};

/** Platform-agnostic workspace state reader. */
export const workspaceState: StateAccessor = {
  get<T>(key: string, defaultValue?: T): T {
    return _workspaceState.get(key, defaultValue as T);
  },
  update: (key: string, value: unknown) => _workspaceState.update(key, value),
};
