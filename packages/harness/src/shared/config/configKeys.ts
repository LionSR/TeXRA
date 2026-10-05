/**
 * Shared TeXRA configuration key helpers.
 *
 * Hosts store settings as flat `texra.<key>` entries. Callers may pass either
 * spelling to the configuration API; storage always uses the canonical key.
 */
const TEXRA_PREFIX = 'texra.';

export function stripPrefix(key: string): string {
  return key.startsWith(TEXRA_PREFIX) ? key.slice(TEXRA_PREFIX.length) : key;
}

export function canonicalConfigKey(key: string): string {
  return `${TEXRA_PREFIX}${stripPrefix(key)}`;
}
