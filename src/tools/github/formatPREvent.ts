/**
 * Natural-language formatting for PR webhook-style events.
 *
 * Output text is wrapped in a `<github-webhook-activity>` tag so the agent can
 * recognize that the follow-up came from an external subscription rather than
 * direct user typing. Keep text short and factual — the agent will fetch more
 * detail via its tools if needed.
 */

import type {
  GhCheckRun,
  GhIssueComment,
  GhReview,
  GhReviewComment,
} from './prTypes';

const OPEN_TAG = '<github-webhook-activity>';
const CLOSE_TAG = '</github-webhook-activity>';

const MAX_BODY = 500;

function truncate(s: string | null | undefined): string {
  const body = (s ?? '').trim();
  if (body.length <= MAX_BODY) return body;
  return body.slice(0, MAX_BODY) + '…';
}

function wrap(inner: string): string {
  return `${OPEN_TAG}\n${inner}\n${CLOSE_TAG}`;
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
  return wrap(
    `New line review comment on ${slug}#${prNumber} by @${author} at ${loc}:\n\n${truncate(c.body)}\n\n${c.html_url}`,
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
    `CI check "${run.name}" on ${slug}#${prNumber} completed with conclusion: ${run.conclusion}.\n\n${run.html_url}`,
  );
}

export function formatCheckFailureSummary(
  slug: string,
  prNumber: number,
  runs: GhCheckRun[],
): string {
  const lines = runs.map(
    (r) => `  • ${r.name} → ${r.conclusion} (${r.html_url})`,
  );
  return wrap(
    `${runs.length} CI checks on ${slug}#${prNumber} failed:\n${lines.join('\n')}`,
  );
}

export function formatPRClosed(
  slug: string,
  prNumber: number,
  merged: boolean,
): string {
  const verb = merged ? 'merged' : 'closed';
  return wrap(
    `${slug}#${prNumber} was ${verb}. Subscription ended.`,
  );
}
