import { platform } from '@platform/platform';
import { GOAL_FEATURE_FLAG_KEY } from '@shared/schemas';

/**
 * Whether Goal (autonomous-continuation mode) is enabled.
 *
 * Goal graduated from experimental in June 2026 and is ON by default. Read this
 * everywhere instead of `platform().config.get(...)` directly so the default
 * stays in one place.
 */
export function isGoalEnabled(): boolean {
  return platform().config.get<boolean>(GOAL_FEATURE_FLAG_KEY, true);
}
