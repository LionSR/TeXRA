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
import { Effect } from 'effect';

// Local imports
import { formatIssueClosed, formatIssueReopened } from './formatIssueEvent';
import { formatCommentEvent } from './formatUtils';
import { withSince } from './githubPaths';
import {
  pollGet,
  readNewItems,
  type PollEvent,
  type PollResult,
} from './poller';
import { dedupeComments, type DedupedResource } from './pollingDedup';
import {
  GhIssueCommentArraySchema,
  GhIssueSchema,
  type GhIssueComment,
} from './prTypes';
import type { IssueTarget } from './subscriptionTarget';

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
  const issuePath = `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
  const [issueRes, commentsRes] = yield* Effect.all(
    [
      pollGet(issuePath, GhIssueSchema, prior?.etags.issue),
      pollGet(
        withSince(
          `${issuePath}/comments?per_page=100`,
          prior?.comments?.sinceCursor,
        ),
        GhIssueCommentArraySchema,
        prior?.etags.comments,
      ),
    ],
    { concurrency: 2 },
  );

  // A malformed issue skips only the state check, and malformed comments
  // only the comment diff (`pollGet`), so neither blocks the other.
  const events: PollEvent[] = [];
  let state = prior?.state;
  let issueEtag = prior?.etags.issue;
  if (issueRes.status === 200) {
    const issueData = issueRes.data;
    issueEtag = issueRes.etag;
    if (prior !== undefined && state !== issueData.state) {
      if (state === 'open' && issueData.state === 'closed') {
        events.push(formatIssueClosed(issue, issueData));
      } else if (state === 'closed') {
        events.push(formatIssueReopened(issue, issueData));
      }
    }
    state = issueData.state;
  }

  const comments = readNewItems(
    prior?.comments,
    commentsRes,
    dedupeComments<GhIssueComment>,
  );
  events.push(...comments.fresh.map((c) => formatCommentEvent(issue, c)));

  return {
    next: {
      state,
      comments: comments.seen,
      etags: {
        issue: issueEtag,
        comments:
          commentsRes.status === 200 ? commentsRes.etag : prior?.etags.comments,
      },
    },
    events,
  } satisfies PollResult<IssueState>;
});
