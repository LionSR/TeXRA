// Local imports - shared core schema
import { CLI_CONFIG_SLOT_KEYS } from '@shared/schemas';

// Local imports - CLI extension schema
import { CLI_SETTING_PATHS } from './cliSettings';

/**
 * Authoritative set of canonical `texra.*` keys recognized by the CLI for
 * unknown-key detection in `.texra/config.json`.
 *
 * Derived from the two catalog facts that decide it — the CLI's runtime honors
 * the row (`honoredBy.cli`) and the CLI's slot for it is `config` — plus the
 * CLI-only paths (`agent`, `model`, etc.). Keys the CLI doesn't read from
 * `.texra/config.json` are excluded by that same derivation, so they still warn
 * as unknown:
 *
 * - Settings no CLI reader honors (`agentReview.*`). Other hosts may write them
 *   to the shared TeXRA config, but they have no CLI behavior.
 * - Settings the CLI reads from its `state.json` store (workflow/latexdiff):
 *   putting those in `config.json` is a no-op.
 */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLI_CONFIG_SLOT_KEYS,
  ...CLI_SETTING_PATHS.map((path) => `texra.${path}`),
]);
