// Third-party imports
import * as vscode from 'vscode';

/**
 * Gets a configuration value from VS Code settings.
 *
 * Path conventions:
 * - Use dot notation without the 'texra' prefix (e.g., 'agents', 'api.engine')
 * - The function will automatically try multiple namespaces:
 *   1. The path as given (for non-texra configs like 'latex.latexindentConfig')
 *   2. Under the 'texra' namespace
 *   3. With explicit 'texra.' prefix
 *
 * @param path Configuration path (e.g., 'agents' or 'api.engine')
 * @param defaultValue Optional default value if configuration is not found
 * @returns The configuration value or default value
 */
export function getConfig<T>(path: string, defaultValue?: T): T {
  const parts = path.split('.');

  // First try getting the config as is (e.g., for latex.latexindentConfig)
  let result: any = vscode.workspace
    .getConfiguration(parts[0])
    .get(parts.slice(1).join('.'));

  // If not found, try under texra namespace
  if (result === undefined) {
    result = vscode.workspace.getConfiguration('texra').get(path);
  }

  // If still not found, try with explicit texra prefix
  if (result === undefined) {
    result = vscode.workspace.getConfiguration().get(`texra.${path}`);
  }

  // Return default value if still undefined
  return result !== undefined ? result : (defaultValue as T);
}

/**
 * Updates a configuration value in VS Code settings.
 *
 * Path conventions:
 * - Use dot notation without the 'texra' prefix for extension settings
 *   (e.g., 'agents', 'api.engine')
 * - Non-extension settings should set `prefix` to false and pass the full key
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
  const {
    target = vscode.ConfigurationTarget.Workspace,
    prefix = true,
    ifUnset = false,
  } = options;

  const key = prefix && !path.startsWith('texra.') ? `texra.${path}` : path;

  if (ifUnset) {
    const setting = vscode.workspace.getConfiguration().inspect(key);
    if (
      setting &&
      setting.globalValue === undefined &&
      setting.workspaceValue === undefined &&
      setting.workspaceFolderValue === undefined
    ) {
      await vscode.workspace.getConfiguration().update(key, value, target);
    }
  } else {
    await vscode.workspace.getConfiguration().update(key, value, target);
  }
}

// Backwards-compatible alias
export const setConfig = updateConfig;

/**
 * Register a listener for configuration changes on the given key(s).
 *
 * @param context Extension context used to dispose the listener
 * @param keys Configuration key or array of keys to watch
 * @param callback Callback executed when any watched key changes
 * @returns Disposable for the registered listener
 */
export function watchConfig(
  context: vscode.ExtensionContext,
  keys: string | readonly string[],
  callback: () => void,
): vscode.Disposable {
  const keyArray = [keys].flat();

  const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (keyArray.some((key) => e.affectsConfiguration(key))) {
      callback();
    }
  });

  context.subscriptions.push(disposable);
  return disposable;
}
