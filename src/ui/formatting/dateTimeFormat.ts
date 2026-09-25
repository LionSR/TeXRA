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
  const key = JSON.stringify(options);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter;
}
