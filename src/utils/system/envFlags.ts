/**
 * How TeXRA reads a boolean environment variable, in one place.
 *
 * Every host had grown its own spelling of this check — `env[NAME]` truthiness
 * in the update checkers, `=== '1' || === 'true'` in the desktop secrets shim —
 * so `TEXRA_NO_UPDATE_CHECK=0` disabled update checks in one host and
 * `TEXRA_DISABLE_KEYCHAIN=yes` did nothing in another. A user who writes `=0`
 * means off in both.
 */
const ENV_FLAG_OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Whether `name` is set to something that means "on".
 *
 * Unset, empty, and the explicit off spellings (`0`, `false`, `no`, `off`,
 * case-insensitive) are false; any other value is true, so `=1`, `=true`, and a
 * bare `=yes` all work.
 */
export function isEnvFlagEnabled(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[name];
  if (value == null) return false;
  return !ENV_FLAG_OFF_VALUES.has(value.trim().toLowerCase());
}
