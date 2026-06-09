import { platform } from '@platform/platform';

import {
  LEGACY_ODYSSEY_FEATURE_FLAG_KEY,
  ODYSSEY_FEATURE_FLAG_KEY,
} from './odysseyMeta';

/**
 * Whether Odyssey (autonomous-continuation mode) is enabled.
 *
 * Odyssey graduated from experimental in June 2026 and is now ON by default.
 * Resolution order:
 *   1. The canonical `texra.odyssey.enabled` key, if the user set it.
 *   2. The legacy `texra.experimental.odyssey.enabled` key, if the user set it
 *      (back-compat for configs written before graduation).
 *   3. Default: enabled.
 *
 * Read this everywhere instead of `platform().config.get(...)` directly so the
 * default and the legacy fallback stay in one place.
 */
export function isOdysseyEnabled(): boolean {
  const config = platform().config;
  if (config.isExplicitlySet(ODYSSEY_FEATURE_FLAG_KEY)) {
    return config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, true);
  }
  if (config.isExplicitlySet(LEGACY_ODYSSEY_FEATURE_FLAG_KEY)) {
    return config.get<boolean>(LEGACY_ODYSSEY_FEATURE_FLAG_KEY, true);
  }
  return true;
}
