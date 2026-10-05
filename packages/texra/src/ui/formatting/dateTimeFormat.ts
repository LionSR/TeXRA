/**
 * Cached `Intl.DateTimeFormat` instances, keyed by their options — the shared
 * home for the "singleton formatter over static options" shape the
 * progressView and settingsView frontends each built independently. Safe for
 * any of the three hosts: only the global `Intl`/`Date`, no `vscode` and no
 * Node built-ins.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function cachedDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  // Sorted so the same options produce the same key regardless of property
  // order (plain `JSON.stringify` would key on insertion order instead).
  const key = Object.entries(options)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter;
}
