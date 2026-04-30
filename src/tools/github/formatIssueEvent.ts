/**
 * Natural-language formatters for `IssuePollingSource`.
 *
 * Path form mirrors GitHub's REST URL shape: `owner/repo/issues/N`.
 */

import {
  truncate as truncateBody,
  wrapWebhookEvent as wrap,
} from './formatUtils';
import type { GhIssue, GhIssueComment } from './prTypes';

const MAX_BODY = 500;

function truncate(s: string | null | undefined): string {
  return truncateBody(s, MAX_BODY);
}

export function formatIssueComment(
  slug: string,
  issueNumber: number,
  c: GhIssueComment,
): string {
  const author = c.user?.login ?? 'someone';
  return wrap(
    `New comment on ${slug}/issues/${issueNumber} by @${author}:\n\n${truncate(c.body)}\n\n${c.html_url}`,
  );
}

export function formatIssueClosed(
  slug: string,
  issueNumber: number,
  issue: GhIssue,
): string {
  const reason = issue.state_reason
    ? ` (state_reason: ${issue.state_reason})`
    : '';
  return wrap(
    `${slug}/issues/${issueNumber} was closed${reason}. Subscription remains active in case the issue reopens.`,
  );
}

export function formatIssueReopened(
  slug: string,
  issueNumber: number,
  issue: GhIssue,
): string {
  return wrap(
    `${slug}/issues/${issueNumber} was reopened: "${truncate(issue.title)}"\n\n${issue.html_url}`,
  );
}

export function formatIssueSubscriptionError(
  slug: string,
  issueNumber: number,
  detail: string,
): string {
  return wrap(
    `Issue subscription to ${slug}/issues/${issueNumber} halted: ${detail}`,
  );
}
