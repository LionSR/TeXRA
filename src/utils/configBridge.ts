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

// ---------------------------------------------------------------------------
// Convenience accessors wrapping readConfig for commonly used settings.
// These mirror the functions previously exported from @utils/config/constants
// and @utils/config/providerConfig, but without VS Code dependencies.
// ---------------------------------------------------------------------------

/** Get the maximum number of automatic retry attempts for model calls. */
export function getModelRetryMaxAttempts(): number {
  return readConfig<number>('texra.model.retry.maxAttempts', 1);
}

/** Get the backoff delay in milliseconds between retry attempts. */
export function getModelRetryBackoffMs(): number {
  return readConfig<number>('texra.model.retry.backoffMs', 1000);
}

/** Determine whether tool-use session persistence is enabled. */
export function getToolUsePersistenceEnabled(): boolean {
  return readConfig<boolean>('texra.toolUse.persistence.enabled', true);
}

/** Resolve the configured TTL (in hours) for persisted tool-use sessions. */
export function getToolUsePersistenceTtlHours(): number {
  const DEFAULT_TTL = 336; // 2 weeks
  const value = readConfig<number>('texra.toolUse.persistence.ttlHours', DEFAULT_TTL);
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1) {
    return DEFAULT_TTL;
  }
  return hours;
}
