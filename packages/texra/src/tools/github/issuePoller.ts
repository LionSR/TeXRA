/**
 * One poll of a subscribed issue: two GETs.
 *
 *   GET /repos/{o}/{r}/issues/{n}                       (state transitions)
 *   GET /repos/{o}/{r}/issues/{n}/comments?since=…      (new comments)
 *
 * Reports new comments, the issue closing (with `state_reason`) and
 * reopening. Unlike a pull request, a closed issue stays subscribed, since a
 * reopen is a genuine signal; the slot is released by an unsubscribe or the
 * 24 h unreachable gate.
 */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import {
  formatIssueClosed,
  formatIssueComment,
  formatIssueReopened,
} from './formatIssueEvent';
import { withSince } from './githubPaths';
import { ghGet } from './githubClient';
import {
  readNewItems,
  validateOrSkip,
  type PollEvent,
  type PollResult,
} from './poller';
import { dedupeComments, type DedupedResource } from './pollingDedup';
import {
  GhIssueCommentArraySchema,
  GhIssueSchema,
  type GhIssueComment,
} from './prTypes';
import { targetPath, type IssueTarget } from './subscriptionTarget';

/** What an issue's next poll starts from. */
export interface IssueState {
  /** The last state read from a valid issue payload. */
  readonly state: 'open' | 'closed' | undefined;
  /** `undefined` until a valid comments list has been read. */
  readonly comments: DedupedResource<GhIssueComment> | undefined;
  readonly etags: { readonly issue?: string; readonly comments?: string };
}

/** Poll `issue` once from `prior`. */
export const pollIssue = Effect.fn('github.pollIssue')(function* (
  issue: IssueTarget,
  prior: IssueState | undefined,
) {
  const path = targetPath(issue);
  const issuePath = `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
  const [issueRes, commentsRes] = yield* Effect.all(
    [
      ghGet(issuePath, Schema.Unknown, prior?.etags.issue),
      ghGet(
        withSince(
          `${issuePath}/comments?per_page=100`,
          prior?.comments?.sinceCursor,
        ),
        Schema.Unknown,
        prior?.etags.comments,
      ),
    ],
    { concurrency: 2 },
  );

  // Each payload is validated on its own: a malformed issue skips only the
  // state check, and malformed comments only the comment diff, so neither
  // blocks the other. A skipped resource keeps its ETag and cursor, so the
  // next poll fetches it again.
  const events: PollEvent[] = [];
  let state = prior?.state;
  let issueEtag = prior?.etags.issue;
  const parsedIssue = yield* validateOrSkip(
    issueRes,
    GhIssueSchema,
    `Skipping issue-state check for ${path}: malformed issue payload`,
  );
  if (parsedIssue?.status === 200) {
    const issueData = parsedIssue.data;
    issueEtag = parsedIssue.etag;
    if (prior !== undefined && state !== issueData.state) {
      if (state === 'open' && issueData.state === 'closed') {
        events.push(formatIssueClosed(issue, issueData));
      } else if (state === 'closed') {
        events.push(formatIssueReopened(issue, issueData));
      }
    }
    state = issueData.state;
  }

  let comments = prior?.comments;
  let commentsEtag = prior?.etags.comments;
  const parsedComments = yield* validateOrSkip(
    commentsRes,
    GhIssueCommentArraySchema,
    `Skipping comments tick for ${path}: malformed comments payload`,
  );
  if (parsedComments?.status === 200) {
    const read = readNewItems(
      comments,
      parsedComments,
      dedupeComments<GhIssueComment>,
    );
    comments = read.seen;
    commentsEtag = parsedComments.etag;
    events.push(...read.fresh.map((c) => formatIssueComment(issue, c)));
  }

  return {
    next: {
      state,
      comments,
      etags: { issue: issueEtag, comments: commentsEtag },
    },
    events,
  } satisfies PollResult<IssueState>;
});
