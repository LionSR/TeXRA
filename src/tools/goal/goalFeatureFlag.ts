import type { ConfigProvider } from '@platform/interfaces';
import { GOAL_FEATURE_FLAG_KEY } from '@shared/schemas';
import { readConfigSettingFrom } from '@utils/config/platformSettings';

/**
 * Whether Goal (autonomous-continuation mode) is enabled in one workspace's
 * configuration (a session's `roots.config`).
 *
 * Goal graduated from experimental in June 2026 and is ON by default. Read
 * this everywhere instead of `config.get(...)` directly: it is the catalog
 * row's read (default on; an invalid stored value warns and reads as the
 * default), the same one the `plan` tool's injection makes.
 */
export function isGoalEnabled(config: ConfigProvider): boolean {
  return readConfigSettingFrom<boolean>(config, GOAL_FEATURE_FLAG_KEY);
}
