/**
 * Configuration facade — convenience wrapper over platform().config.
 */
import { tryPlatform } from '@platform/platform';

export function getConfig<T>(key: string, defaultValue?: T): T {
  const p = tryPlatform();
  return p ? p.config.get(key, defaultValue) : (defaultValue as T);
}
