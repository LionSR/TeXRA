/**
 * Natural-language formatters for `IssuePollingSource`.
 *
 * Path form mirrors GitHub's REST URL shape: `owner/repo/issues/N`. Each
 * formatter declares the message structure (headline + optional body +
 * optional URL) via shared helpers from `formatUtils`.
 */

import {
  formatCommentEvent,
  makeTruncator,
  sections,
  wrapWebhookEvent as wrap,
} from './formatUtils';
import { issueRef } from './githubPaths';
import type { GhIssue, GhIssueComment } from './prTypes';

const MAX_BODY = 500;

const truncate = makeTruncator(MAX_BODY);

export function formatIssueComment(
  slug: string,
  issueNumber: number,
  c: GhIssueComment,
): string {
  return formatCommentEvent(issueRef(slug, issueNumber), c, MAX_BODY);
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
    `${issueRef(slug, issueNumber)} was closed${reason}. Subscription remains active in case the issue reopens.`,
  );
}

export function formatIssueReopened(
  slug: string,
  issueNumber: number,
  issue: GhIssue,
): string {
  return wrap(
    sections(
      `${issueRef(slug, issueNumber)} was reopened: "${truncate(issue.title)}"`,
      issue.html_url,
    ),
  );
}

export function formatIssueSubscriptionError(
  slug: string,
  issueNumber: number,
  detail: string,
): string {
  return wrap(
    `Issue subscription to ${issueRef(slug, issueNumber)} halted: ${detail}`,
  );
}
