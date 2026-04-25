/**
 * Natural-language formatting for PR webhook-style events.
 *
 * Output text is wrapped in a `<github-webhook-activity>` tag so the agent can
 * recognize that the follow-up came from an external subscription rather than
 * direct user typing. Keep text short and factual — the agent will fetch more
 * detail via its tools if needed.
 */

import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';

import type {
  GhCheckRun,
  GhIssueComment,
  GhReview,
  GhReviewComment,
} from './prTypes';

const TAG = 'github-webhook-activity';
const MAX_BODY = 500;

function truncate(s: string | null | undefined): string {
  const body = (s ?? '').trim();
  if (body.length <= MAX_BODY) return body;
  return body.slice(0, MAX_BODY) + '…';
}

/**
 * Sanitizing per-field is easy to forget when a new formatter is added;
 * doing it at the wrap boundary closes the attack surface by construction.
 * Every comment/review body, username, CI check name, file path, or URL
 * interpolated into the wrapper flows through here.
 */
function wrap(inner: string): string {
  return wrapAndSanitizeTag(TAG, inner);
}

export function formatIssueComment(
  slug: string,
  prNumber: number,
  c: GhIssueComment,
): string {
  const author = c.user?.login ?? 'someone';
  return wrap(
    `New comment on ${slug}#${prNumber} by @${author}:\n\n${truncate(c.body)}\n\n${c.html_url}`,
  );
}

export function formatReviewComment(
  slug: string,
  prNumber: number,
  c: GhReviewComment,
): string {
  const author = c.user?.login ?? 'someone';
  const line = c.line ?? c.original_line;
  const loc = line ? `${c.path}:${line}` : c.path;
  const prefix =
    c.in_reply_to_id != null
      ? 'Reply to inline review thread'
      : 'New line review comment';
  return wrap(
    `${prefix} on ${slug}#${prNumber} by @${author} at ${loc}:\n\n${truncate(c.body)}\n\n${c.html_url}`,
  );
}

export function formatReview(
  slug: string,
  prNumber: number,
  r: GhReview,
): string {
  const author = r.user?.login ?? 'someone';
  const verb =
    r.state === 'APPROVED'
      ? 'approved'
      : r.state === 'CHANGES_REQUESTED'
        ? 'requested changes on'
        : r.state === 'COMMENTED'
          ? 'commented on'
          : r.state === 'DISMISSED'
            ? 'dismissed a review on'
            : 'reviewed';
  const body = r.body ? `\n\n${truncate(r.body)}` : '';
  return wrap(
    `@${author} ${verb} ${slug}#${prNumber}.${body}\n\n${r.html_url}`,
  );
}

export function formatCheckFailure(
  slug: string,
  prNumber: number,
  run: GhCheckRun,
): string {
  return wrap(
    `The following CI check failed on the PR. Investigate the failure and determine what action (if any) is needed.\n\n` +
      `PR: ${slug}#${prNumber}\n` +
      `Check: ${run.name}\n` +
      `Conclusion: ${run.conclusion}\n` +
      `Details: ${run.html_url}`,
  );
}

export function formatCheckFailureSummary(
  slug: string,
  prNumber: number,
  runs: GhCheckRun[],
): string {
  const entries = runs
    .map(
      (r) =>
        `Check: ${r.name}\nConclusion: ${r.conclusion}\nDetails: ${r.html_url}`,
    )
    .join('\n\n');
  return wrap(
    `${runs.length} CI checks failed on the PR. Investigate the failures and determine what action (if any) is needed.\n\n` +
      `PR: ${slug}#${prNumber}\n\n` +
      entries,
  );
}

/** Non-blocking conclusions: `success`, `neutral` (advisory), `skipped`. */
export function isPassingConclusion(conclusion: string | null): boolean {
  return (
    conclusion === 'success' ||
    conclusion === 'neutral' ||
    conclusion === 'skipped'
  );
}

export function formatCIPassed(
  slug: string,
  prNumber: number,
  sha: string,
  runs: GhCheckRun[],
): string {
  return wrap(
    `All ${runs.length} CI checks passed on ${slug}#${prNumber} (head ${sha.slice(0, 7)}).`,
  );
}

export function formatCIComplete(
  slug: string,
  prNumber: number,
  sha: string,
  runs: GhCheckRun[],
): string {
  const passed = runs.filter((r) => isPassingConclusion(r.conclusion)).length;
  const failed = runs.length - passed;
  return wrap(
    `CI completed on ${slug}#${prNumber} (head ${sha.slice(0, 7)}): ${passed} passed, ${failed} failed.`,
  );
}

export function formatPRClosed(
  slug: string,
  prNumber: number,
  merged: boolean,
): string {
  const verb = merged ? 'merged' : 'closed';
  return wrap(`${slug}#${prNumber} was ${verb}. Subscription ended.`);
}

/**
 * Error events delivered into the follow-up queue when the poller hits an
 * unrecoverable condition (auth rejected, repeated failures). Same
 * `<github-webhook-activity>` envelope + sanitize path as every other event
 * so agents can't mistake these for direct user input and so an adversarial
 * GitHub error payload can't inject tag-shaped content unsanitized.
 */
export function formatSubscriptionError(
  slug: string,
  prNumber: number,
  detail: string,
): string {
  return wrap(`PR subscription to ${slug}#${prNumber} halted: ${detail}`);
}
