/**
 * Polling URL and cursor helpers: `withSince` adds the `since=` parameter a
 * comment list is polled with, and `getNewestTimestamp` reads the cursor a
 * list advances it to.
 */

/**
 * Append a `since=` query param to a poll URL, choosing `?` or `&` based on
 * whether the URL already has a query string. No-op when `since` is undefined.
 */
export function withSince(url: string, since: string | undefined): string {
  if (!since) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}since=${encodeURIComponent(since)}`;
}

/** Newest `updated_at` (falling back to `created_at`) in a list, or undefined. */
export function getNewestTimestamp(
  items: ReadonlyArray<{
    created_at?: string | null;
    updated_at?: string | null;
  }>,
): string | undefined {
  let best: string | undefined;
  for (const it of items) {
    const t = it.updated_at ?? it.created_at;
    if (t && (!best || t > best)) best = t;
  }
  return best;
}
