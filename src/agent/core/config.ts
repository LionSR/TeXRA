/**
 * Platform-agnostic configuration facade for the agent core.
 *
 * Thin wrapper over `platform().config`. Consumer code imports this
 * module for convenience; the canonical definition lives in
 * `@platform/interfaces`.
 */
import { tryPlatform } from '@platform/platform';

export interface ConfigProvider {
  get<T>(key: string, defaultValue?: T): T;
}

/** Read a configuration value. Returns defaultValue if platform not yet initialized. */
export function getConfig<T>(key: string, defaultValue?: T): T {
  const p = tryPlatform();
  return p ? p.config.get(key, defaultValue) : (defaultValue as T);
}
