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
