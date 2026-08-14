// Local imports - shared core schema
import { CLI_CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';

// Local imports - state-backed settings catalog (canonical key list)
import { CLI_STATE_SETTINGS } from '@shared/schemas/stateSettings';

// Local imports - CLI extension schema
import { CLI_SETTING_PATHS } from './cliSettings';

/**
 * Authoritative set of canonical `texra.*` keys recognized by the CLI for
 * unknown-key detection in `.texra/config.json`.
 *
 * Derived from the Core settings a non-VS-Code host actually reads, CLI-only
 * paths (`agent`, `model`, etc.), and the state-backed settings the CLI reads
 * *from config*. Keys the CLI doesn't read from `.texra/config.json` are
 * intentionally excluded so they still warn as unknown:
 *
 * - Core settings the CLI does not consume (`agentReview.*`). Other hosts may
 *   write them to the shared TeXRA config, but they have no CLI behavior.
 * - State-backed settings the CLI reads from its `state.json` store
 *   (workflow/latexdiff): putting those in `config.json` is a no-op.
 */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLI_CORE_SETTING_PATHS.map((path) => `texra.${path}`),
  ...CLI_SETTING_PATHS.map((path) => `texra.${path}`),
  // State-backed settings the CLI reads from config (git author marking, via
  // `cliStore: 'config'`) — derived from the catalog rather than hand-listed.
  ...CLI_STATE_SETTINGS.filter(
    (entry) => (entry.cliStore ?? entry.store) === 'config',
  ).map((entry) => entry.key),
]);
