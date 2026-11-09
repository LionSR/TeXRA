/**
 * One poll of a subscribed pull request: its detail, conversation and review
 * comments, reviews and the head commit's check runs, read with the previous
 * poll's cursors and ETags, then folded into the next state and the events
 * to report. Annotated check runs queue for the annotations endpoint, which
 * each poll drains a few runs of under the process's annotation budget.
 */

// Third-party imports
import { Effect } from 'effect';
import type { RateLimiterError } from 'effect/persistence/RateLimiter';

// Local imports
import { includesCheckAnnotationLevel } from './checkAnnotationLevels';
import {
  fetchAllCheckRuns,
  fetchAnnotations,
  type CheckRunsCache,
} from './checkRunsClient';
import {
  formatCheckAnnotations,
  formatCheckFailure,
  formatCheckFailureSummary,
  formatCIComplete,
  formatCIPassed,
  formatCIStarted,
  formatMergeConflictDetected,
  formatMergeConflictResolved,
  formatPRClosed,
  formatReview,
  formatReviewComment,
} from './formatPREvent';
import { formatCommentEvent } from './formatUtils';
import { withSince } from './githubPaths';
import {
  checkKey,
  ciTerminalStatus,
  computeNewCheckFailures,
  isCheckFailure,
  planAnnotationCandidates,
} from './prCheckRunDomain';
import {
  logWarning,
  pollGet,
  readNewItems,
  type PollEvent,
  type PollResult,
} from './poller';
import { dedupeComments, DedupedResource, MAX_SEEN_IDS } from './pollingDedup';
import {
  GhIssueCommentArraySchema,
  GhPullRequestSchema,
  GhReviewArraySchema,
  GhReviewCommentArraySchema,
  isDefiniteMergeableState,
  type GhCheckAnnotation,
  type GhCheckRun,
  type GhIssueComment,
  type GhReview,
  type GhReviewComment,
} from './prTypes';
import type { PullTarget } from './subscriptionTarget';

// Coalesce this many same-kind events in a single tick into a summary.
const COALESCE_THRESHOLD = 3;
// Bound the per-subscription fan-out across runs (e.g. a matrix build
// lighting up a fleet of checks). Excess candidates stay queued and are
// drained on later polls.
const MAX_ANNOTATION_RUNS_PER_POLL = 3;

/** What a pull request's next poll starts from. */
export interface PullState {
  readonly etags: {
    readonly pr?: string;
    readonly issueComments?: string;
    readonly reviewComments?: string;
    readonly reviews?: string;
  };
  readonly issueComments: DedupedResource<GhIssueComment> | undefined;
  readonly reviewComments: DedupedResource<GhReviewComment> | undefined;
  readonly reviews: DedupedResource<GhReview> | undefined;
  readonly lastFailedCheckKeys: ReadonlySet<string>;
  /**
   * `${id}:${completed_at}` for runs observed (with annotations) on the most
   * recent 200 check-runs response. Replaced wholesale on each one (mirrors
   * `lastFailedCheckKeys`) so it can't grow unboundedly and FIFO eviction
   * can't mistake a still-present run for a new one.
   */
  readonly lastAnnotationKeys: ReadonlySet<string>;
  /**
   * Everything scoped to the current head SHA. Replaced wholesale whenever
   * the head SHA changes, so a per-SHA field can't leak stale state across a
   * push.
   */
  readonly head: HeadState | undefined;
  /** Last *definite* `mergeable_state`; see `isDefiniteMergeableState`. */
  readonly mergeableState: string | undefined;
}

/** Per-head-SHA state; reset wholesale whenever the head SHA changes. */
interface HeadState {
  readonly sha: string;
  /** Whether the one-shot "CI triggered" event has been emitted for `sha`. */
  readonly ciStarted: boolean;
  /** Whether the one-shot "CI complete" event has been emitted for `sha`. */
  readonly ciComplete: boolean;
  /** Whether the one-shot "CI passed" event has been emitted for `sha`. */
  readonly ciPassed: boolean;
  readonly checkRunsCache: CheckRunsCache | undefined;
  /**
   * Annotated runs awaiting an annotations-endpoint fetch, drained on every
   * poll (200 or 304) so a burst that overflows the per-poll or process-wide
   * budget isn't stranded once the check-runs cache stabilizes.
   */
  readonly pendingAnnotationRuns: readonly GhCheckRun[];
}

function isSubmittedReview(review: GhReview): boolean {
  // PENDING reviews are the token owner's own drafts. A review keeps its id
  // when it is submitted, so recording a draft would swallow the submission.
  return review.state !== 'PENDING';
}

/**
 * Poll `pr` once from `prior`. `claimAnnotation` takes one unit of the
 * annotation-page budget every pull request of the process shares.
 */
export const pollPull = Effect.fn('github.pollPull')(function* (
  pr: PullTarget,
  claimAnnotation: Effect.Effect<void, RateLimiterError>,
  prior: PullState | undefined,
) {
  const prPath = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  const issuePath = `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}`;
  const events: PollEvent[] = [];

  let head = prior?.head;
  let mergeableState = prior?.mergeableState;
  let prEtag = prior?.etags.pr;
  const prRes = yield* pollGet(prPath, GhPullRequestSchema, prEtag);
  if (prRes.status === 200) {
    const prData = prRes.data;
    // A closed PR cannot produce any later activity worth polling.
    if (prData.state === 'closed') {
      return {
        next: prior,
        events: [formatPRClosed(pr, prData.merged)],
        ended: true,
      } satisfies PollResult<PullState>;
    }
    prEtag = prRes.etag;
    // A new push invalidates the prior CI state and the check-runs page
    // cache, whose ETags can never match the new SHA's responses.
    if (head?.sha !== prData.head.sha) {
      head = {
        sha: prData.head.sha,
        ciStarted: false,
        ciComplete: false,
        ciPassed: false,
        checkRunsCache: undefined,
        pendingAnnotationRuns: [],
      };
    }
    // Only definite-to-definite reads count, so the first poll (and any
    // poll where GitHub returns `'unknown'`) is silent.
    const newMergeable = prData.mergeable_state;
    if (isDefiniteMergeableState(newMergeable)) {
      const prev = mergeableState;
      mergeableState = newMergeable;
      if (isDefiniteMergeableState(prev) && prev !== newMergeable) {
        if (newMergeable === 'dirty') {
          events.push(formatMergeConflictDetected(pr, prev));
        } else if (prev === 'dirty') {
          events.push(formatMergeConflictResolved(pr, newMergeable));
        }
      }
    }
  }

  const [commentsRes, reviewCommentsRes, reviewsRes, checks] =
    yield* Effect.all(
      [
        pollGet(
          withSince(
            `${issuePath}/comments?per_page=100`,
            prior?.issueComments?.sinceCursor,
          ),
          GhIssueCommentArraySchema,
          prior?.etags.issueComments,
        ),
        pollGet(
          withSince(
            `${prPath}/comments?per_page=100`,
            prior?.reviewComments?.sinceCursor,
          ),
          GhReviewCommentArraySchema,
          prior?.etags.reviewComments,
        ),
        pollGet(
          `${prPath}/reviews?per_page=100`,
          GhReviewArraySchema,
          prior?.etags.reviews,
        ),
        head
          ? fetchAllCheckRuns(
              pr.owner,
              pr.repo,
              head.sha,
              head.checkRunsCache,
            ).pipe(
              // A malformed page skips the whole walk for this poll: no cache
              // comes back, so the CI state and page cache stay as they were.
              // A cached page read in its place could mix runs from two
              // moments and make CI look terminal when it is not.
              Effect.catchTag('GitHubMalformedBodyError', (error) =>
                logWarning(
                  `Skipping check runs of ${prPath} this poll: malformed page`,
                  error,
                ).pipe(
                  Effect.as({
                    response: { status: 304 as const },
                    cache: undefined,
                  }),
                ),
              ),
            )
          : Effect.succeed({
              response: { status: 304 as const },
              cache: undefined,
            }),
      ],
      { concurrency: 4 },
    );
  // The first poll records what CI already reported, which needs the pull
  // request and its check runs. It sends no ETag, so anything but a 200 is a
  // skipped malformed body: record nothing, and the next poll is the first.
  if (
    prior === undefined &&
    (prRes.status !== 200 || checks.response.status !== 200)
  ) {
    return { next: undefined, events: [] } satisfies PollResult<PullState>;
  }

  const issueComments = readNewItems(
    prior?.issueComments,
    commentsRes,
    dedupeComments<GhIssueComment>,
  );
  events.push(...issueComments.fresh.map((c) => formatCommentEvent(pr, c)));
  const reviewComments = readNewItems(
    prior?.reviewComments,
    reviewCommentsRes,
    dedupeComments<GhReviewComment>,
  );
  events.push(...reviewComments.fresh.map((c) => formatReviewComment(pr, c)));
  const reviews = readNewItems(
    prior?.reviews,
    reviewsRes.status === 200
      ? { ...reviewsRes, data: reviewsRes.data.filter(isSubmittedReview) }
      : reviewsRes,
    () =>
      new DedupedResource<GhReview>({
        getId: (review) => review.id,
        maxSeenIds: MAX_SEEN_IDS,
      }),
  );
  events.push(...reviews.fresh.map((r) => formatReview(pr, r)));

  let lastFailedCheckKeys = prior?.lastFailedCheckKeys ?? new Set<string>();
  let lastAnnotationKeys = prior?.lastAnnotationKeys ?? new Set<string>();
  if (head && checks.response.status === 200) {
    const runs = checks.response.data.check_runs;
    const totalCount = checks.response.data.total_count;
    const { complete, passed } = ciTerminalStatus(head.sha, runs, totalCount);
    if (prior === undefined) {
      // The first poll records what CI already reported, so only later
      // transitions surface; the timestamp in a key lets a rerun re-emit.
      lastFailedCheckKeys = new Set(runs.filter(isCheckFailure).map(checkKey));
      lastAnnotationKeys = new Set(
        runs
          .filter(
            (r) =>
              r.status === 'completed' &&
              (r.output?.annotations_count ?? 0) > 0,
          )
          .map(checkKey),
      );
      head = {
        ...head,
        ciStarted: runs.length > 0,
        ciComplete: complete,
        ciPassed: complete && passed,
      };
    } else {
      if (runs.length > 0 && !head.ciStarted) {
        head = { ...head, ciStarted: true };
        events.push(formatCIStarted(pr, head.sha, runs, totalCount));
      }
      const { newFailures, currentFailureKeys } = computeNewCheckFailures(
        runs,
        lastFailedCheckKeys,
      );
      lastFailedCheckKeys = currentFailureKeys;
      if (newFailures.length >= COALESCE_THRESHOLD) {
        events.push(formatCheckFailureSummary(pr, newFailures));
      } else {
        events.push(...newFailures.map((r) => formatCheckFailure(pr, r)));
      }
      // "CI complete" fires on the first terminal state (any conclusion),
      // "CI passed" the first time every check passes, which may come with a
      // later rerun after "CI complete" already fired.
      if (complete && !head.ciComplete) {
        head = { ...head, ciComplete: true };
        events.push(formatCIComplete(pr, head.sha, runs));
      }
      if (complete && passed && !head.ciPassed) {
        head = { ...head, ciPassed: true };
        events.push(formatCIPassed(pr, head.sha, runs));
      }
      // Annotations also surface on passing checks (lint suggestions, custom
      // workflow advisories), so they queue independently of failures.
      const plan = planAnnotationCandidates(
        runs,
        lastAnnotationKeys,
        head.pendingAnnotationRuns,
      );
      lastAnnotationKeys = plan.newCurrentKeys;
      head = {
        ...head,
        pendingAnnotationRuns: [
          ...head.pendingAnnotationRuns.map(
            (run, index) => plan.replacementsByIndex.get(index) ?? run,
          ),
          ...plan.toAppend,
        ],
      };
    }
  }
  if (head && checks.cache !== undefined) {
    head = { ...head, checkRunsCache: checks.cache };
  }
  if (head && head.pendingAnnotationRuns.length > 0) {
    const drained = yield* drainAnnotations(
      pr,
      head.pendingAnnotationRuns,
      claimAnnotation,
    );
    head = { ...head, pendingAnnotationRuns: drained.pending };
    events.push(...drained.events);
  }

  return {
    next: {
      etags: {
        pr: prEtag,
        issueComments: etagOf(commentsRes, prior?.etags.issueComments),
        reviewComments: etagOf(reviewCommentsRes, prior?.etags.reviewComments),
        reviews: etagOf(reviewsRes, prior?.etags.reviews),
      },
      issueComments: issueComments.seen,
      reviewComments: reviewComments.seen,
      reviews: reviews.seen,
      lastFailedCheckKeys,
      lastAnnotationKeys,
      head,
      mergeableState,
    },
    events,
  } satisfies PollResult<PullState>;
});

function etagOf(
  res: { status: 200; etag: string | undefined } | { status: 304 },
  prior: string | undefined,
): string | undefined {
  return res.status === 200 ? res.etag : prior;
}

/**
 * Fetch the annotations of up to {@link MAX_ANNOTATION_RUNS_PER_POLL} queued
 * runs, front first. Annotations are best-effort, so a single bad check
 * must not halt the whole subscription:
 *
 * - fetched: report, remove from the queue;
 * - the process budget is spent: stop, keep the queue for the next poll;
 * - 404/410/422 or 401/403: log and drop the run (a 401/403 here is almost
 *   always a permission-scoped token; the main poll handles bad tokens);
 * - anything else (network, timeout): rotate the run to the back.
 *
 * A GitHub rate limit fails the poll, so the subscription's own wait governs
 * every endpoint.
 */
const drainAnnotations = Effect.fn('github.drainAnnotations')(function* (
  pr: PullTarget,
  pending: readonly GhCheckRun[],
  claimAnnotation: Effect.Effect<void, RateLimiterError>,
) {
  let queue = pending;
  const events: PollEvent[] = [];
  for (
    let attempt = 0;
    attempt < MAX_ANNOTATION_RUNS_PER_POLL && queue.length > 0;
    attempt += 1
  ) {
    const [run, ...rest] = queue;
    const drop = (reason: string, err: Error) =>
      logWarning(
        `Annotations for check ${run.id} ${reason}; dropping.`,
        err,
      ).pipe(Effect.as('drop' as const));
    const rotate = (err: Error) =>
      logWarning(
        `Annotation fetch for check ${run.id} failed; rotating to back of queue`,
        err,
      ).pipe(Effect.as('rotate' as const));
    const outcome = yield* fetchAnnotations(
      pr.owner,
      pr.repo,
      run.id,
      claimAnnotation,
    ).pipe(
      Effect.catchTags({
        RateLimiterError: (err) =>
          err.reason._tag === 'RateLimitExceeded'
            ? Effect.succeed('budget' as const)
            : rotate(err),
        GitHubAuthError: (err) => drop('forbidden', err),
        GitHubPermanentError: (err) => drop('unavailable', err),
        GitHubTransientError: rotate,
        SecretsFailed: rotate,
      }),
    );
    if (outcome === 'budget') break;
    queue = outcome === 'rotate' ? [...rest, run] : rest;
    if (typeof outcome !== 'string' && outcome.length > 0) {
      events.push(annotationEvent(pr, run, outcome));
    }
  }
  return { pending: queue, events };
});

/** The annotations each run sees: those at or above its own level. */
function annotationEvent(
  pr: PullTarget,
  run: GhCheckRun,
  annotations: readonly GhCheckAnnotation[],
): PollEvent {
  return (minLevel) => {
    const visible = annotations.filter((annotation) =>
      includesCheckAnnotationLevel(annotation.annotation_level, minLevel),
    );
    if (visible.length === 0) return undefined;
    return formatCheckAnnotations(
      pr,
      {
        ...run,
        output: { ...run.output, annotations_count: visible.length },
      },
      visible,
    );
  };
}
