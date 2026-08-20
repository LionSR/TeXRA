// Local imports - shared core schema
import { CLI_CONFIG_SLOT_KEYS } from '@shared/schemas';

// Local imports - CLI extension schema
import { CLI_SETTING_PATHS } from './cliSettings';

/**
 * Authoritative set of canonical `texra.*` keys recognized by the CLI for
 * unknown-key detection in `.texra/config.json`.
 *
 * Derived from config-backed catalog rows that the CLI runtime honors
 * (`honoredBy.cli`) or an exceptional CLI path writes (`writtenBy.cli`), plus
 * the CLI-only paths (`agent`, `model`, etc.). Keys with neither CLI runtime
 * behavior nor a recorded CLI writer are excluded by that derivation, so they
 * still warn as unknown:
 *
 * - Settings no CLI reader honors and no exceptional CLI path writes
 *   (`agentReview.*`). Other hosts may write them to the shared TeXRA config,
 *   but they have no CLI behavior.
 * - Settings the CLI reads from its `state.json` store (workflow/latexdiff):
 *   putting those in `config.json` is a no-op.
 */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLI_CONFIG_SLOT_KEYS,
  ...CLI_SETTING_PATHS.map((path) => `texra.${path}`),
]);
