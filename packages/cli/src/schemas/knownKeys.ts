// Local imports - shared core schema
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';

// Local imports - state-backed settings catalog (canonical key list)
import { CLI_STATE_SETTINGS } from '@shared/schemas/stateSettings';

// Local imports - compatibility keys
import { LEGACY_GOAL_FEATURE_FLAG_KEYS } from '@shared/schemas/goal';

// Local imports - CLI extension schema
import { CLI_SETTING_PATHS } from './cliSettings';

/**
 * Authoritative set of canonical `texra.*` keys recognized by the CLI for
 * unknown-key detection in `.texra/config.json`.
 *
 * Derived from Core paths (universal config settings), CLI-only paths
 * (`agent`, `model`, etc.), and the state-backed settings the CLI reads *from
 * config*. Keys the CLI doesn't read from `.texra/config.json` are intentionally
 * excluded so they still warn as unknown — including state-backed settings the
 * CLI reads from its `state.json` store (workflow/latexdiff): putting those in
 * `config.json` is a no-op the warning should catch.
 */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...CORE_SETTING_PATHS.map((path) => `texra.${path}`),
  ...CLI_SETTING_PATHS.map((path) => `texra.${path}`),
  // Keep warning behavior aligned with runtime compatibility for pre-rename
  // `texra.odyssey.*` keys that `isGoalEnabled()` still honors when set.
  ...LEGACY_GOAL_FEATURE_FLAG_KEYS,
  // State-backed settings the CLI reads from config (git author marking, via
  // `cliStore: 'config'`) — derived from the catalog rather than hand-listed.
  ...CLI_STATE_SETTINGS.filter(
    (entry) => (entry.cliStore ?? entry.store) === 'config',
  ).map((entry) => entry.key),
]);
