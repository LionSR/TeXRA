/**
 * Shared message-formatter helpers for the GitHub event formatters.
 *
 * Trivial enough to inline at each call site — but having one canonical
 * version means the truncation cap and the webhook-activity wrapper tag stay
 * consistent across all subscription paths (PR / repo / issue). Reference
 * paths and polling URL/cursor helpers live in `./githubPaths`.
 */

import { DELIVERY_TAG } from '@shared/deliveryTags';
import { isNonEmptyString } from '@utils/core';
import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import type { GhIssueComment } from './prTypes';

const WEBHOOK_TAG = DELIVERY_TAG.githubWebhookActivity;

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
  return parts.filter(isNonEmptyString).join('\n\n');
}

export function truncate(s: string | null | undefined, max: number): string {
  return truncateWithEllipsis((s ?? '').trim(), max);
}

/**
 * Build a single-arg truncator bound to `max`, so each formatter keeps one
 * file-local cap instead of re-declaring the `(s) => truncate(s, MAX)` wrapper.
 */
export function makeTruncator(
  max: number,
): (s: string | null | undefined) => string {
  return (s) => truncate(s, max);
}

/**
 * "New comment on <ref> by <author>:" event, shared by the issue- and
 * PR-comment formatters — they differ only in whether `ref` is an issue or
 * pull path. The repo-level formatter uses a denser single-line shape and
 * intentionally does not route through here.
 */
export function formatCommentEvent(
  ref: string,
  c: GhIssueComment,
  maxBody: number,
): string {
  return wrapWebhookEvent(
    sections(
      `New comment on ${ref} by ${authorOf(c.user)}:`,
      truncate(c.body, maxBody),
      c.html_url,
    ),
  );
}
