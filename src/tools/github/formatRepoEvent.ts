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
 */

import {
  formatPreviousStateHint,
  truncate as truncateBody,
  wrapWebhookEvent as wrap,
} from './formatUtils';
import type {
  GhIssueComment,
  GhPullsListEntry,
  GhReviewComment,
} from './prTypes';

const MAX_BODY = 200;

function truncate(s: string | null | undefined): string {
  return truncateBody(s, MAX_BODY);
}

export function formatRepoPROpened(slug: string, pr: GhPullsListEntry): string {
  const author = pr.user?.login ?? 'someone';
  return wrap(
    `New pull request ${slug}/pulls/${pr.number} opened by @${author}: "${truncate(pr.title)}"\n${pr.html_url}`,
  );
}

export function formatRepoPRClosed(
  slug: string,
  prNumber: number,
  merged: boolean,
): string {
  const verb = merged ? 'merged' : 'closed';
  return wrap(`${slug}/pulls/${prNumber} was ${verb}.`);
}

export function formatRepoIssueComment(
  slug: string,
  number: number,
  c: GhIssueComment,
): string {
  const author = c.user?.login ?? 'someone';
  return wrap(
    `New comment on ${slug}/issues/${number} by @${author}: "${truncate(c.body)}"\n${c.html_url}`,
  );
}

export function formatRepoReviewComment(
  slug: string,
  prNumber: number,
  c: GhReviewComment,
): string {
  const author = c.user?.login ?? 'someone';
  const reply =
    c.in_reply_to_id != null ? 'review reply' : 'inline review comment';
  return wrap(
    `New ${reply} on ${slug}/pulls/${prNumber} by @${author} (${c.path}): "${truncate(c.body)}"\n${c.html_url}`,
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
    `Merge conflict detected on ${slug}/pulls/${prNumber}: mergeable_state="dirty"${formatPreviousStateHint(prevState)}. ` +
      `Subscribe to ${slug}/pulls/${prNumber} for nuanced events, or rebase / merge the base back in to resolve.`,
  );
}

/**
 * Coalesced "many PRs newly conflicted" notification — fires when the same
 * tick discovers `>= COALESCE_THRESHOLD` PRs that flipped to dirty. Avoids
 * spraying the orchestrator with one event per PR after a base-branch
 * merge invalidates many PRs at once.
 */
export function formatRepoMergeConflictSummary(
  slug: string,
  prNumbers: readonly number[],
): string {
  const list = prNumbers.map((n) => `${slug}/pulls/${n}`).join('\n');
  return wrap(
    `Merge conflicts detected on ${prNumbers.length} PRs in ${slug} (mergeable_state="dirty"). ` +
      `Likely caused by a recent base-branch update — subscribe per-PR for nuanced events, or rebase / merge the base back in.\n\n` +
      list,
  );
}

export function formatRepoSubscriptionError(
  slug: string,
  detail: string,
): string {
  return wrap(`Repo subscription to ${slug} halted: ${detail}`);
}
