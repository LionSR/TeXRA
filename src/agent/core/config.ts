/**
 * Platform-agnostic configuration facade for the agent core.
 *
 * Delegates to a settable provider. Default: returns the default value.
 * VS Code calls `setConfigProvider()` at activation to use
 * vscode.workspace.getConfiguration.
 */

export interface ConfigProvider {
  get<T>(key: string, defaultValue?: T): T;
}

const defaultProvider: ConfigProvider = {
  get<T>(_key: string, defaultValue?: T): T {
    return defaultValue as T;
  },
};

let provider: ConfigProvider = defaultProvider;

/** Replace the config provider. Called once at platform init. */
export function setConfigProvider(p: ConfigProvider): void {
  provider = p;
}

/** Read a configuration value. */
export function getConfig<T>(key: string, defaultValue?: T): T {
  return provider.get(key, defaultValue);
}

// ---------------------------------------------------------------------------
// Convenience wrappers (previously in @utils/config/constants.ts)
// ---------------------------------------------------------------------------

/** Maximum number of automatic retry attempts for model calls. */
export function getModelRetryMaxAttempts(): number {
  return getConfig<number>('texra.model.retry.maxAttempts', 1);
}

/** Backoff delay in milliseconds between retry attempts. */
export function getModelRetryBackoffMs(): number {
  return getConfig<number>('texra.model.retry.backoffMs', 1000);
}
