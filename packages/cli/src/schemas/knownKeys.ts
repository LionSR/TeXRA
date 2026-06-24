// Local imports - shared core schema
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';

// Local imports - state-backed settings catalog (canonical key list)
import { STATE_SETTING_KEYS } from '@shared/schemas/stateSettings';

// Local imports - compatibility keys
import { LEGACY_GOAL_FEATURE_FLAG_KEYS } from '@shared/schemas/goal';

// Local imports - CLI extension schema
import { CLI_SETTING_PATHS } from './cliSettings';

/**
 * Authoritative set of canonical `texra.*` keys recognized by the CLI for
 * unknown-key detection in `.texra/config.json`.
 *
 * Derived from Core paths (universal config settings), CLI-only paths
 * (`agent`, `model`, etc.), and the state-backed settings catalog. VS Code-only
 * keys are intentionally excluded: the CLI doesn't validate against another
 * host's surface — anything not in this set warns as unknown.
 *
 * The state-backed keys (git commit-author marking, workflow/latexdiff
 * settings, …) are stored as workspace state in the VS Code extension, but the
 * catalog is the single source of truth for their canonical key names, so they
 * are recognized here without a hand-maintained list.
 */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...CORE_SETTING_PATHS.map((path) => `texra.${path}`),
  ...CLI_SETTING_PATHS.map((path) => `texra.${path}`),
  // Keep warning behavior aligned with runtime compatibility for pre-rename
  // `texra.odyssey.*` keys that `isGoalEnabled()` still honors when set.
  ...LEGACY_GOAL_FEATURE_FLAG_KEYS,
  // State-backed settings (git author marking, workflow/latexdiff, …) derived
  // from the catalog rather than hand-listed.
  ...STATE_SETTING_KEYS,
]);
