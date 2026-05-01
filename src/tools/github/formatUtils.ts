/**
 * Shared helpers for the GitHub event formatters and pollers.
 *
 * Trivial enough to inline at each call site — but having one canonical
 * version means the truncation cap, the cursor-advance semantics, and the
 * webhook-activity wrapper tag stay consistent across all subscription
 * paths (PR / repo / issue).
 */

import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';

const WEBHOOK_TAG = 'github-webhook-activity';

/**
 * Wrap formatter output in the `<github-webhook-activity>` envelope. The
 * sanitize step closes the tag-injection attack surface by construction;
 * every comment body, username, CI name, file path, or URL interpolated
 * into the wrapper flows through here.
 */
export function wrapWebhookEvent(inner: string): string {
  return wrapAndSanitizeTag(WEBHOOK_TAG, inner);
}

/**
 * Renders an optional " (was \"X\")" hint for transition messages, or empty
 * string when no prior state is known. Used by both PR and repo merge-
 * conflict formatters.
 */
export function formatPreviousStateHint(prevState: string | undefined): string {
  return prevState ? ` (was "${prevState}")` : '';
}

/** Canonical PR reference path, e.g. `owner/repo/pulls/42`. */
export function prRef(slug: string, prNumber: number): string {
  return `${slug}/pulls/${prNumber}`;
}

/** Canonical issue reference path, e.g. `owner/repo/issues/42`. */
export function issueRef(slug: string, issueNumber: number): string {
  return `${slug}/issues/${issueNumber}`;
}

/**
 * `@login` for an author, falling back to `@someone` for anonymous /
 * deleted-account events. Centralized so the fallback string stays
 * consistent across every formatter.
 */
export function authorOf(user: { login: string } | null | undefined): string {
  return `@${user?.login ?? 'someone'}`;
}

/**
 * Compose paragraph-separated sections, dropping empty / falsy entries so
 * a missing comment body or URL doesn't produce a stray blank paragraph.
 * Each non-empty entry becomes a paragraph separated by a blank line.
 */
export function sections(
  ...parts: ReadonlyArray<string | null | undefined | false>
): string {
  return parts
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');
}

export function truncate(s: string | null | undefined, max: number): string {
  const body = (s ?? '').trim();
  if (body.length <= max) return body;
  return body.slice(0, max) + '…';
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
    const t = it.updated_at ?? it.created_at ?? undefined;
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

/**
 * Drop the oldest entries from a Set so its size doesn't exceed `maxSize`.
 * Map and Set iteration order is insertion order, so this is FIFO.
 */
export function trimSet<T>(set: Set<T>, maxSize: number): void {
  const excess = set.size - maxSize;
  if (excess <= 0) return;
  const iter = set.values();
  for (let i = 0; i < excess; i += 1) set.delete(iter.next().value as T);
}

/**
 * FIFO-trim a Map to `maxSize` entries by deleting the oldest keys (Map
 * iteration is insertion order, so deleting `keys().next().value` repeatedly
 * evicts oldest-first). Mirrors `trimSet` for the Map case.
 *
 * Pair with `setRecent` on the write side so "oldest" reflects "least
 * recently touched" rather than "earliest first inserted" — `Map.set` on
 * an existing key does NOT refresh insertion order, so a plain `set` would
 * let `trimMap` evict actively-touched entries.
 */
export function trimMap<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Set `key` → `value` with LRU-style ordering: an existing entry is
 * deleted first so `set` re-inserts at the tail, keeping `trimMap`'s
 * eviction aligned with "least recently touched". Use this whenever a
 * Map is paired with `trimMap` and entries can be updated.
 */
export function setRecent<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}
