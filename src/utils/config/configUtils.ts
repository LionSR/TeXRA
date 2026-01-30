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
export function getConfig<T>(path: string, defaultValue?: T): T;
export function getConfig<T>(section: string, key: string, defaultValue?: T): T;
export function getConfig<T>(
  pathOrSection: string,
  keyOrDefault?: string | T,
  defaultValue?: T,
): T {
  if (typeof keyOrDefault === 'string' && defaultValue !== undefined) {
    const value = vscode.workspace
      .getConfiguration(pathOrSection)
      .get<T>(keyOrDefault);
    return value !== undefined ? value : (defaultValue as T);
  }

  if (typeof keyOrDefault === 'string' && defaultValue === undefined) {
    const inspection = vscode.workspace
      .getConfiguration(pathOrSection)
      .inspect(keyOrDefault);
    if (inspection) {
      return vscode.workspace
        .getConfiguration(pathOrSection)
        .get<T>(keyOrDefault) as T;
    }
  }

  const parts = pathOrSection.split('.');

  // Try multiple namespaces in order of priority (using === undefined to preserve null values)
  let result: unknown = vscode.workspace
    .getConfiguration(parts[0])
    .get(parts.slice(1).join('.'));

  if (result === undefined) {
    result = vscode.workspace.getConfiguration('texra').get(pathOrSection);
  }
  if (result === undefined) {
    result = vscode.workspace.getConfiguration().get(`texra.${pathOrSection}`);
  }

  return result !== undefined ? (result as T) : (keyOrDefault as T);
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
      (setting.globalValue !== undefined ||
        setting.workspaceValue !== undefined ||
        setting.workspaceFolderValue !== undefined)
    ) {
      return; // Setting already exists, don't update
    }
  }

  await vscode.workspace.getConfiguration().update(key, value, target);
}

/**
 * Returns true if a configuration key has been explicitly set by the user
 * at any scope (global, workspace, or workspace folder).
 */
export function isConfigExplicitlySet(key: string): boolean {
  const inspection = vscode.workspace.getConfiguration().inspect(key);
  return (
    inspection?.globalValue !== undefined ||
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined
  );
}

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
