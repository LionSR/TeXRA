import { platform } from '@platform/platform';
import {
  LEGACY_GOAL_FEATURE_FLAG_KEYS,
  GOAL_FEATURE_FLAG_KEY,
} from '@shared/schemas/goal';

/**
 * Whether Goal (autonomous-continuation mode) is enabled.
 *
 * Goal (formerly "Odyssey") graduated from experimental in June 2026 and is now
 * ON by default. Resolution order:
 *   1. The canonical `texra.goal.enabled` key, if the user set it.
 *   2. Any pre-rename `texra.odyssey.*` key, if the user set it (back-compat).
 *   3. Default: enabled.
 *
 * Read this everywhere instead of `platform().config.get(...)` directly so the
 * default and the legacy fallback stay in one place.
 */
export function isGoalEnabled(): boolean {
  const config = platform().config;
  if (config.isExplicitlySet(GOAL_FEATURE_FLAG_KEY)) {
    return config.get<boolean>(GOAL_FEATURE_FLAG_KEY, true);
  }
  for (const legacyKey of LEGACY_GOAL_FEATURE_FLAG_KEYS) {
    if (config.isExplicitlySet(legacyKey)) {
      return config.get<boolean>(legacyKey, true);
    }
  }
  return true;
}
