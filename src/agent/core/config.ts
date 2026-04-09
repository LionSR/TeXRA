/**
 * Platform-agnostic configuration facade for the agent core.
 *
 * Thin wrapper over `platform().config`. Consumer code imports this
 * module for convenience; the canonical definition lives in
 * `@platform/interfaces`.
 */
import { platform } from '@platform/platform';

export interface ConfigProvider {
  get<T>(key: string, defaultValue?: T): T;
}

/** Read a configuration value. */
export function getConfig<T>(key: string, defaultValue?: T): T {
  return platform().config.get(key, defaultValue);
}
