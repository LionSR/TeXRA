import type { ConfigProvider } from '@platform/interfaces';
import { GOAL_FEATURE_FLAG_KEY } from '@shared/schemas';

/**
 * Whether Goal (autonomous-continuation mode) is enabled in one workspace's
 * configuration (a session's `roots.config`).
 *
 * Goal graduated from experimental in June 2026 and is ON by default. Read
 * this everywhere instead of `config.get(...)` directly so the default stays
 * in one place.
 */
export function isGoalEnabled(config: ConfigProvider): boolean {
  return config.get<boolean>(GOAL_FEATURE_FLAG_KEY, true);
}
