/**
 * Canonical GitHub reference paths and polling URL/cursor helpers.
 *
 * `prRef`/`issueRef` build the reference paths used by both the event
 * formatters (PR / repo / issue) and the subscription pollers; `withSince`
 * and `getNewestTimestamp` are the polling URL-param and cursor-advance
 * plumbing. Kept together so the reference-path shape, the query-string
 * separator choice, and the cursor semantics stay consistent across every
 * subscription path.
 */

/** Canonical PR reference path, e.g. `owner/repo/pulls/42`. */
export function prRef(slug: string, prNumber: number): string {
  return `${slug}/pulls/${prNumber}`;
}

/** Canonical issue reference path, e.g. `owner/repo/issues/42`. */
export function issueRef(slug: string, issueNumber: number): string {
  return `${slug}/issues/${issueNumber}`;
}

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
