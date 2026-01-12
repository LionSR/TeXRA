// Third-party imports
import * as vscode from 'vscode';

// Local imports - state management
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

/**
 * Mapping from VS Code config keys to workspace storage keys.
 * Settings listed here are stored in workspaceState instead of package.json config.
 * This allows removing these settings from package.json while maintaining the same API.
 */
const STORAGE_KEY_MAP: Record<string, WorkspaceStateKey> = {
  'texra.agentOutputs.storageMode': WorkspaceStateKey.STORAGE_MODE,
  'texra.toolUse.persistence.enabled': WorkspaceStateKey.PERSIST_SESSIONS,
  'texra.toolUse.persistence.ttlHours': WorkspaceStateKey.SESSION_RETENTION,
  'texra.model.compactionThresholdPercent': WorkspaceStateKey.COMPACTION_THRESHOLD,
  'texra.model.retry.maxAttempts': WorkspaceStateKey.MAX_RETRY_ATTEMPTS,
  'texra.model.retry.backoffMs': WorkspaceStateKey.RETRY_BACKOFF_MS,
  'texra.latex.formatter': WorkspaceStateKey.FORMATTER,
  'texra.latexdiff.mathMarkup': WorkspaceStateKey.MATH_MARKUP,
};

/**
 * Normalize a config path to its full form (with texra. prefix if applicable).
 */
function normalizeConfigPath(path: string): string {
  return path.startsWith('texra.') ? path : `texra.${path}`;
}

/**
 * Gets a configuration value from VS Code settings or workspace storage.
 *
 * Path conventions:
 * - Use dot notation without the 'texra' prefix (e.g., 'agents', 'api.engine')
 * - The function will automatically try multiple namespaces:
 *   1. The path as given (for non-texra configs like 'latex.latexindentConfig')
 *   2. Under the 'texra' namespace
 *   3. With explicit 'texra.' prefix
 *
 * Storage-based settings:
 * - Certain settings are stored in workspace storage instead of VS Code config
 * - This is transparent to callers - the same getConfig API is used
 *
 * @param path Configuration path (e.g., 'agents' or 'api.engine')
 * @param defaultValue Optional default value if configuration is not found
 * @returns The configuration value or default value
 */
export function getConfig<T>(path: string, defaultValue?: T): T {
  // Check if this is a storage-based setting
  const normalizedPath = normalizeConfigPath(path);
  const storageKey = STORAGE_KEY_MAP[normalizedPath];

  if (storageKey && workspaceSM) {
    const result = workspaceSM.get<T>(storageKey);
    return result !== undefined ? result : (defaultValue as T);
  }

  // Fall back to VS Code configuration
  const parts = path.split('.');

  // Try multiple namespaces in order of priority (using === undefined to preserve null values)
  let result: unknown = vscode.workspace
    .getConfiguration(parts[0])
    .get(parts.slice(1).join('.'));

  if (result === undefined) {
    result = vscode.workspace.getConfiguration('texra').get(path);
  }
  if (result === undefined) {
    result = vscode.workspace.getConfiguration().get(`texra.${path}`);
  }

  return result !== undefined ? (result as T) : (defaultValue as T);
}

/**
 * Updates a configuration value in VS Code settings or workspace storage.
 *
 * Path conventions:
 * - Use dot notation without the 'texra' prefix for extension settings
 *   (e.g., 'agents', 'api.engine')
 * - Non-extension settings should set `prefix` to false and pass the full key
 *
 * Storage-based settings:
 * - Certain settings are stored in workspace storage instead of VS Code config
 * - This is transparent to callers - the same updateConfig API is used
 *
 * @param path Configuration path
 * @param value The value to set
 * @param options Additional options for the update
 * @returns Promise that resolves when configuration is updated
 */
export async function updateConfig<T>(
  path: string,
  value: T,
  options: {
    target?: vscode.ConfigurationTarget;
    prefix?: boolean;
    ifUnset?: boolean;
  } = {},
): Promise<void> {
  const { prefix = true, ifUnset = false } = options;

  const key = prefix && !path.startsWith('texra.') ? `texra.${path}` : path;

  // Check if this is a storage-based setting
  const storageKey = STORAGE_KEY_MAP[key];

  if (storageKey && workspaceSM) {
    if (ifUnset) {
      const existing = workspaceSM.get(storageKey);
      if (existing !== undefined) {
        return; // Setting already exists, don't update
      }
    }
    await workspaceSM.update(storageKey, value);
    return;
  }

  // Fall back to VS Code configuration
  const { target = vscode.ConfigurationTarget.Workspace } = options;

  if (ifUnset) {
    const setting = vscode.workspace.getConfiguration().inspect(key);
    if (
      setting &&
      (setting.globalValue !== undefined ||
        setting.workspaceValue !== undefined ||
        setting.workspaceFolderValue !== undefined)
    ) {
      return; // Setting already exists, don't update
    }
  }

  await vscode.workspace.getConfiguration().update(key, value, target);
}

// Backwards-compatible alias
export const setConfig = updateConfig;

/**
 * Register a listener for configuration changes on the given keys.
 *
 * @param context Extension context used to dispose the listener
 * @param keys Configuration keys to watch
 * @param callback Callback executed when any watched key changes
 * @returns Disposable for the registered listener
 */
export function watchConfig(
  context: vscode.ExtensionContext,
  keys: string | string[],
  callback: () => void,
): vscode.Disposable {
  const keyArray = Array.isArray(keys) ? keys : [keys];

  const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (keyArray.some((key) => e.affectsConfiguration(key))) {
      callback();
    }
  });

  context.subscriptions.push(disposable);
  return disposable;
}
