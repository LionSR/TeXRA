/**
 * Configuration facade — convenience wrapper over platform().config.
 *
 * Falls back to defaultValue before platform initialization to
 * support module-level calls.
 */
import { tryPlatform } from '@platform/platform';
import type { ConfigProvider } from '@platform/interfaces/config';

// Re-export the type so existing `import { ConfigProvider } from '@agent/core/config'` works.
export type { ConfigProvider };

export function getConfig<T>(key: string, defaultValue?: T): T {
  const p = tryPlatform();
  return p ? p.config.get(key, defaultValue) : (defaultValue as T);
}
