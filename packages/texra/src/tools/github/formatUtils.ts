/**
 * Shared message-formatter helpers for the GitHub event formatters.
 *
 * Trivial enough to inline at each call site — but having one canonical
 * version means the truncation cap and the webhook-activity wrapper tag stay
 * consistent across all subscription paths (PR / repo / issue). Reference
 * paths are `targetPath` (`./subscriptionTarget`).
 */

import { truncateWithEllipsis } from '@texra-ai/harness/schemas';
import type { GhIssueComment } from './prTypes';
import {
  TARGET_LABEL,
  targetPath,
  type SubscriptionTarget,
} from './subscriptionTarget';

/** The envelope every GitHub event reaches its run's model in. */
const WEBHOOK_TAG = 'github-webhook-activity';

/** The cap on a comment or title quoted in an issue or pull request event. */
export const MAX_BODY = 500;

/**
 * Matches `</tag>` and `<tag>` liberally — whitespace inside the tag,
 * case-insensitive — because LLMs and HTML parsers both accept variants like
 * `</tag >`, `< / tag >`, etc. as closers. Derived from `WEBHOOK_TAG` so a
 * rename of the delivery tag cannot desync the neutralizer from the wrapper.
 * Module-scope despite the `g` flag: `String.prototype.replaceAll` goes
 * through `RegExp.prototype[Symbol.replace]`, which resets `lastIndex`.
 */
const WEBHOOK_TAG_RE = new RegExp(`<\\s*/?\\s*${WEBHOOK_TAG}\\s*>`, 'gi');
/**
 * The tag name with a zero-width space after its first character, so no
 * re-parser can reconstruct it. Guarding only the outside of the tag would
 * leave the middle structurally intact.
 */
const BROKEN_WEBHOOK_TAG = `${WEBHOOK_TAG.at(0)}${String.fromCharCode(0x200b)}${WEBHOOK_TAG.slice(1)}`;

/** One event as a run receives it: the envelope its model reads, and its
 *  headline, which the transcript and the queued list show instead. */
export interface WebhookEvent {
  readonly text: string;
  readonly displayText?: string;
}

/**
 * Wrap formatter output in the `<github-webhook-activity>` envelope, first
 * neutralizing any literal occurrence of the tag inside the body so a payload
 * coming from an untrusted source (PR webhook fields, agent names, etc.)
 * cannot escape the wrapper and feed text to the LLM as if it were direct
 * user input. Every comment body, username, CI name, file path, or URL
 * interpolated into the wrapper flows through here. Its headline is the
 * body's first line.
 */
export function wrapWebhookEvent(inner: string): WebhookEvent {
  const neutralized = inner.replaceAll(WEBHOOK_TAG_RE, (match) =>
    match.includes('/')
      ? `</${BROKEN_WEBHOOK_TAG}>`
      : `<${BROKEN_WEBHOOK_TAG}>`,
  );
  const headline = neutralized.trim().split('\n')[0]?.trim();
  return {
    text: `<${WEBHOOK_TAG}>\n${neutralized}\n</${WEBHOOK_TAG}>`,
    ...(headline ? { displayText: headline } : {}),
  };
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
  return parts
    .filter(
      (part): part is string => typeof part === 'string' && part.trim() !== '',
    )
    .join('\n\n');
}

/** `s` trimmed and cut to `max` characters; an absent text is empty. */
export function truncate(s: string | null | undefined, max: number): string {
  return truncateWithEllipsis((s ?? '').trim(), max);
}

/** A commit SHA in the seven-character short form git and GitHub print. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * "New comment on <ref> by <author>:" event for a subscribed issue or pull
 * request. GitHub delivers general PR comments over the same `issue_comment`
 * webhook as plain-issue comments; the target decides whether the reference
 * renders as `issues/N` or `pulls/N`. The repo-level formatter uses a denser
 * single-line shape and intentionally does not route through here.
 */
export function formatCommentEvent(
  target: SubscriptionTarget,
  c: GhIssueComment,
): WebhookEvent {
  return wrapWebhookEvent(
    sections(
      `New comment on ${targetPath(target)} by ${authorOf(c.user)}:`,
      truncate(c.body, MAX_BODY),
      c.html_url,
    ),
  );
}

/**
 * The event a run receives when its subscription stops on its own (token
 * rejected, target gone, unreachable for a day). Same envelope as every other
 * event, so an adversarial GitHub error payload cannot inject tag-shaped
 * content and agents cannot mistake it for direct user input.
 */
export function formatSubscriptionHalted(
  target: SubscriptionTarget,
  detail: string,
): WebhookEvent {
  return wrapWebhookEvent(
    `${TARGET_LABEL[target._tag]} subscription to ${targetPath(target)} halted: ${detail}`,
  );
}
