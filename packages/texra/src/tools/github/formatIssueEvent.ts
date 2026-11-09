/**
 * Natural-language formatters for the issue poll (`issuePoller.ts`).
 *
 * Path form mirrors GitHub's REST URL shape: `owner/repo/issues/N`. Each
 * formatter declares the message structure (headline + optional body +
 * optional URL) via shared helpers from `formatUtils`.
 */

import {
  MAX_BODY,
  makeTruncator,
  sections,
  wrapWebhookEvent as wrap,
} from './formatUtils';
import { targetPath, type IssueTarget } from './subscriptionTarget';
import type { GhIssue } from './prTypes';

const truncate = makeTruncator(MAX_BODY);

export function formatIssueClosed(issue: IssueTarget, data: GhIssue): string {
  const reason = data.state_reason
    ? ` (state_reason: ${data.state_reason})`
    : '';
  return wrap(
    `${targetPath(issue)} was closed${reason}. Subscription remains active in case the issue reopens.`,
  );
}

export function formatIssueReopened(issue: IssueTarget, data: GhIssue): string {
  return wrap(
    sections(
      `${targetPath(issue)} was reopened: "${truncate(data.title)}"`,
      data.html_url,
    ),
  );
}
