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
 * Sets a configuration value in VS Code settings.
 *
 * Path conventions:
 * - Use dot notation without the 'texra' prefix (e.g., 'agents', 'api.engine')
 * - The function will automatically add the 'texra.' prefix
 *
 * @param path Configuration path without 'texra' prefix (e.g., 'agents')
 * @param value The value to set
 * @param target Configuration target (defaults to Workspace)
 * @returns Promise that resolves when configuration is updated
 */
export async function setConfig<T>(
  path: string,
  value: T,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace,
): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(`texra.${path}`, value, target);
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
