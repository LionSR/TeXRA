// Local imports - shared core schema
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';

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
]);
