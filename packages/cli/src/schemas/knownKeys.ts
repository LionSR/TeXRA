// Local imports - shared state keys (canonical git-author key names)
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - shared core schema
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';

// Local imports - compatibility keys
import {
  GOAL_FEATURE_FLAG_KEY,
  LEGACY_GOAL_FEATURE_FLAG_KEYS,
} from '@tools/goal';

// Local imports - CLI extension schema
import { CLI_SETTING_PATHS } from './cliSettings';

/**
 * Authoritative set of canonical `texra.*` keys recognized by the CLI for
 * unknown-key detection in `.texra/config.json`.
 *
 * Derived from Core paths (universal settings) and CLI-only paths
 * (`agent`, `model`, etc.). VS Code-only keys are intentionally excluded:
 * the CLI doesn't validate against another host's surface — anything not in
 * this set warns as unknown.
 */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...CORE_SETTING_PATHS.map((path) => `texra.${path}`),
  ...CLI_SETTING_PATHS.map((path) => `texra.${path}`),
  // Keep warning behavior aligned with runtime compatibility: the canonical
  // goal flag plus the pre-rename `texra.odyssey.*` keys that `isGoalEnabled()`
  // still honors when explicitly set.
  GOAL_FEATURE_FLAG_KEY,
  ...LEGACY_GOAL_FEATURE_FLAG_KEYS,
  // Git commit-author marking is stored as workspace state in the VS Code
  // extension, but the CLI reads it from `.texra/config.json`. Recognize the
  // keys here so they don't warn as unknown.
  WorkspaceStateKey.GIT_MARK_COMMITS,
  WorkspaceStateKey.GIT_AUTHOR_NAME,
  WorkspaceStateKey.GIT_AUTHOR_EMAIL,
  WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
]);
