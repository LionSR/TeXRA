/**
 * Natural-language formatters for the issue poll (`issuePoller.ts`).
 *
 * Path form mirrors GitHub's REST URL shape: `owner/repo/issues/N`. Each
 * formatter declares the message structure (headline + optional body +
 * optional URL) via shared helpers from `formatUtils`.
 */

import {
  MAX_BODY,
  sections,
  truncate,
  wrapWebhookEvent as wrap,
  type WebhookEvent,
} from './formatUtils';
import { targetPath, type IssueTarget } from './subscriptionTarget';
import type { GhIssue } from './prTypes';

export function formatIssueClosed(
  issue: IssueTarget,
  data: GhIssue,
): WebhookEvent {
  const reason = data.state_reason
    ? ` (state_reason: ${data.state_reason})`
    : '';
  return wrap(
    `${targetPath(issue)} was closed${reason}. Subscription remains active in case the issue reopens.`,
  );
}

export function formatIssueReopened(
  issue: IssueTarget,
  data: GhIssue,
): WebhookEvent {
  return wrap(
    sections(
      `${targetPath(issue)} was reopened: "${truncate(data.title, MAX_BODY)}"`,
      data.html_url,
    ),
  );
}
