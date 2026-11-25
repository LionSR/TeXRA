/** The date-time formats every host shares. Safe for any of the three hosts:
 *  only the global `Intl`/`Date`, no `vscode` and no Node built-ins. */

const SHORT_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * A moment as every host prints it in a list or a row: locale-aware, short
 * month, no seconds (`Nov 14, 2026, 09:12 AM`). `null` for a missing or
 * unparseable value, which its caller words.
 */
export function formatShortDateTime(
  value: string | number | Date | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return SHORT_DATE_TIME.format(date);
}
