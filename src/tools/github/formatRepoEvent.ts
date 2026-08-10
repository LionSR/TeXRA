/**
 * Coarse-grained formatters for `RepoPollingSource`.
 *
 * Each event is a one-line `<github-webhook-activity>` notification suitable
 * for an orchestrator agent: enough to decide whether to delegate a worker,
 * not enough to act on the PR/issue directly. For nuanced fields (CI state,
 * full review thread, line comment context) the orchestrator should delegate
 * a worker that calls `github_subscription` with command="subscribe" and a
 * `path="owner/repo/pulls/N"` (or `/issues/N`) for the specific item.
 *
 * Path form mirrors GitHub's REST URL shape:
 * - `slug/pulls/N` for definitive PR events (open/close/merge, review-thread).
 * - `slug/issues/N` for events from `/issues/comments` — that endpoint
 *   surfaces both PR conversation comments and plain issue comments
 *   indistinguishably without an extra API call. The `html_url` in the
 *   message body resolves the actual type via GitHub's redirect.
 *
 * Each `format*` function reads as a description of the message rather than
 * a string-building procedure: variant strings live in lookup tables, the
 * recurring "headline + url on next line" pattern is unified, and reference
 * paths / authors flow through shared helpers.
 */

import {
  authorOf,
  formatPreviousStateHint,
  issueRef,
  makeTruncator,
  prRef,
  sections,
  wrapWebhookEvent as wrap,
} from './formatUtils';
import type {
  GhIssueComment,
  GhPullsListEntry,
  GhReviewComment,
} from './prTypes';

const MAX_BODY = 200;

const truncate = makeTruncator(MAX_BODY);

export function formatRepoPROpened(slug: string, pr: GhPullsListEntry): string {
  return wrap(
    `New pull request ${prRef(slug, pr.number)} opened by ${authorOf(pr.user)}: "${truncate(pr.title)}"\n${pr.html_url}`,
  );
}

export function formatRepoPRClosed(
  slug: string,
  prNumber: number,
  merged: boolean,
): string {
  return wrap(`${prRef(slug, prNumber)} was ${merged ? 'merged' : 'closed'}.`);
}

export function formatRepoIssueComment(
  slug: string,
  number: number,
  c: GhIssueComment,
): string {
  return wrap(
    `New comment on ${issueRef(slug, number)} by ${authorOf(c.user)}: "${truncate(c.body)}"\n${c.html_url}`,
  );
}

export function formatRepoReviewComment(
  slug: string,
  prNumber: number,
  c: GhReviewComment,
): string {
  return wrap(
    `New ${c.in_reply_to_id != null ? 'review reply' : 'inline review comment'} on ${prRef(slug, prNumber)} by ${authorOf(c.user)} (${c.path}): "${truncate(c.body)}"\n${c.html_url}`,
  );
}

/**
 * Single-PR merge-conflict notification, mirroring the per-PR formatter but
 * keyed under the repo subscription. Triggered by the holistic probe in
 * `RepoPollingSource` when an open PR's `mergeable_state` flips to `dirty`.
 */
export function formatRepoMergeConflictDetected(
  slug: string,
  prNumber: number,
  prevState: string | undefined,
): string {
  return wrap(
    `Merge conflict detected on ${prRef(slug, prNumber)}: mergeable_state="dirty"${formatPreviousStateHint(prevState)}. ` +
      `Subscribe to ${prRef(slug, prNumber)} for detailed events, or rebase / merge the base back in to resolve.`,
  );
}

/**
 * Coalesced "many PRs newly conflicted" notification — fires when the same
 * tick discovers enough PRs flipping to dirty to cross the repo poller's
 * coalescing threshold. Avoids spraying the orchestrator with one event
 * per PR after a base-branch update invalidates many PRs at once.
 */
export function formatRepoMergeConflictSummary(
  slug: string,
  prNumbers: readonly number[],
): string {
  return wrap(
    sections(
      `Merge conflicts detected on ${prNumbers.length} PRs in ${slug} (mergeable_state="dirty"). Likely caused by a recent base-branch update: subscribe per-PR for detailed events, or rebase / merge the base back in.`,
      prNumbers.map((n) => prRef(slug, n)).join('\n'),
    ),
  );
}

export function formatRepoSubscriptionError(
  slug: string,
  detail: string,
): string {
  return wrap(`Repo subscription to ${slug} halted: ${detail}`);
}
