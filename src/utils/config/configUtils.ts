// Local imports
import { tryPlatform } from '@platform/platform';
import type { ConfigTarget } from '@platform/interfaces/config';
import type { Disposable } from '@platform/interfaces/disposable';

interface ConfigSubscriptionContext {
  subscriptions: Disposable[];
}

interface UpdateConfigOptions {
  target?: ConfigTarget;
  prefix?: boolean;
  ifUnset?: boolean;
}

function configProvider() {
  return tryPlatform()?.config;
}

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
  const provider = configProvider();
  return provider ? provider.get(path, defaultValue) : (defaultValue as T);
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
  options: UpdateConfigOptions = {},
): Promise<void> {
  const { target = 'workspace', prefix = true, ifUnset = false } = options;

  const key = prefix && !path.startsWith('texra.') ? `texra.${path}` : path;
  const provider = configProvider();
  if (!provider) return;

  if (ifUnset && provider.isExplicitlySet(key)) {
    return; // Setting already exists, don't update
  }

  await provider.update(key, value, target);
}

/**
 * Inspect a configuration key to retrieve its raw global/workspace/folder values
 * (without VS Code defaults). Returns `undefined` if the key is not registered.
 */
export function inspectConfig<T = unknown>(key: string) {
  return configProvider()?.inspect<T>(key);
}

/**
 * Checks if a configuration setting has been explicitly set by the user
 * (global, workspace, or workspace folder), rather than using defaults.
 */
export function isConfigExplicitlySet(key: string): boolean {
  return configProvider()?.isExplicitlySet(key) ?? false;
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
  context: ConfigSubscriptionContext,
  keys: string | string[],
  callback: () => void,
): Disposable {
  const keyArray = Array.isArray(keys) ? keys : [keys];
  const provider = configProvider();
  const disposable = provider?.watch(keyArray, callback) ?? {
    dispose: () => {},
  };

  context.subscriptions.push(disposable);
  return disposable;
}
