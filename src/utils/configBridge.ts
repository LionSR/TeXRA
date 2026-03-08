/**
 * Platform-agnostic configuration reader.
 *
 * Provides a `readConfig()` function that can be used safely from VS Code-free
 * zones (src/agent/, src/model/, src/latex/, src/tools/, etc.).
 *
 * The real implementation is injected at activation time via `setConfigProvider()`,
 * called from extension.ts. Before injection, all reads return the supplied default.
 */

type ConfigGetter = <T>(key: string, defaultValue?: T) => T;

let _getConfig: ConfigGetter = <T>(_key: string, defaultValue?: T): T =>
  defaultValue as T;

/**
 * Register the platform-specific config reader.
 * Called once from extension.ts during activation.
 */
export function setConfigProvider(getter: ConfigGetter): void {
  _getConfig = getter;
}

/**
 * Read a configuration value. Safe to call from VS Code-free zones.
 *
 * Before `setConfigProvider()` is called, returns `defaultValue`.
 */
export function readConfig<T>(key: string, defaultValue?: T): T {
  return _getConfig(key, defaultValue);
}
