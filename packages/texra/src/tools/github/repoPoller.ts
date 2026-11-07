/**
 * One poll of a subscribed repository: coarse whole-repo GitHub activity.
 *
 * Designed for orchestrator agents: emits one short message per relevant
 * event ("#N opened by @alice", "#N comment from @bob", "#N merged"),
 * leaving CI status and review-thread linkage to the per-PR poller that a
 * worker subscribes to after the orchestrator decides to dig in.
 *
 * Per tick this issues exactly three repo-scoped GETs regardless of how many
 * PRs are open in the repo:
 *
 *   GET /repos/{o}/{r}/issues/comments?since=…   (issue + PR conversation comments)
 *   GET /repos/{o}/{r}/pulls/comments?since=…    (review thread comments)
 *   GET /repos/{o}/{r}/pulls?state=all&sort=updated  (open/close/merge — the
 *                                                    list endpoint does not
 *                                                    accept `since`)
 *
 * Cost is bounded by repo count, not PR count, so an orchestrator watching
 * one busy repo with 50 open PRs costs the same as one with two open PRs.
 *
 * ## Known coverage gaps
 *
 * - **Reopens of long-dormant PRs.** A PR created before the subscription,
 *   then closed, then reopened later, will be silent if it never appeared
 *   in the top-100-updated `/pulls` window during the subscription
 *   (transition can't be distinguished from "PR just bubbled into the window
 *   after a comment" without per-PR history). Workers needing guaranteed
 *   reopen coverage should subscribe to the specific PR via
 *   `github_subscription` with `path="owner/repo/pulls/N"`.
 * - **Issue open/close transitions.** Only PR transitions are tracked.
 *   Issue conversation comments do flow through.
 * - **Bare APPROVED / DISMISSED reviews without comments.** Live only on
 *   `/pulls/{n}/reviews`; per-PR by design.
 * - **CI / check-run status and inline annotations.** Per-PR by design.
 */

// Third-party imports
import { Clock, Effect, Exit, Result, Schema } from 'effect';
import { LRUCache } from 'lru-cache';

// Local imports
import { shouldDropBotEvent } from './botFilter';
import {
  formatRepoIssueComment,
  formatRepoMergeConflictDetected,
  formatRepoMergeConflictSummary,
  formatRepoPRClosed,
  formatRepoPROpened,
  formatRepoReviewComment,
} from './formatRepoEvent';
import { ghGet } from './githubClient';
import {
  logWarning,
  readNewItems,
  validateOrSkip,
  type PollEvent,
  type PollResult,
} from './poller';
import { copyLru, dedupeComments, type DedupedResource } from './pollingDedup';
import {
  GhIssueCommentArraySchema,
  GhPullRequestSchema,
  GhPullsListEntryArraySchema,
  GhReviewCommentArraySchema,
  isDefiniteMergeableState,
  type GhIssueComment,
  type GhPullRequest,
  type GhPullsListEntry,
  type GhReviewComment,
} from './prTypes';
import { targetPath, type RepoTarget } from './subscriptionTarget';

// We pull all "updated since" data; a sufficiently large window guarantees we
// catch transitions even after a brief network outage. GitHub caps these
// endpoints at 100 per page; we don't paginate — if more than 100 events
// happened in a 30s tick, the orchestrator was about to be overwhelmed
// anyway and missing some is a feature, not a bug.
const PER_PAGE = 100;
// Initial seed window when first subscribing: only events newer than this are
// surfaced. Without it the very first tick would replay the entire backlog.
const SEED_WINDOW_MS = 60_000;
// Cap on the per-PR LRU maps to keep long-lived subscriptions on busy repos
// from accumulating an entry per PR ever seen. The `LRUCache` evicts the
// least-recently-used PR on overflow; `.get()`/`.set()` both refresh recency,
// so closed-and-forgotten PRs roll off before actively-touched ones.
const MAX_PR_STATE_ENTRIES = 500;
// Holistic merge-conflict probing: each tick we GET `/pulls/{N}` for at
// most this many open PRs whose `updated_at` advanced since the prior tick,
// in newest-first order. Bounded so a busy repo can't fan out into one
// extra GET per open PR — at 30s tick interval and 5 probes/tick we add
// ~600 requests/hour per repo, well within the 5,000/hr token budget.
// PRs that aren't probed this tick simply wait their turn: the next push
// or comment will bubble them back to the top of the updated-at order.
const MAX_MERGEABLE_PROBES_PER_TICK = 5;
// Coalesce per-tick merge-conflict events into a single summary above this
// threshold. Mirrors the PR-poller `COALESCE_THRESHOLD`: the typical cause
// of many simultaneous transitions is a base-branch update invalidating
// every open PR, and one summary message is more useful to an orchestrator
// than five individual events.
const MERGE_CONFLICT_COALESCE_THRESHOLD = 3;

type PullStateName = 'open' | 'closed' | 'merged';

/** What a repository's next poll starts from. */
export interface RepoState {
  /**
   * ISO timestamp of the first poll. Gates "PR opened": a first-seen open PR
   * is only treated as newly opened if its `created_at` post-dates this;
   * otherwise it's a backfill (an older PR that just bubbled into the
   * top-100-updated window) and recorded silently.
   */
  readonly subscribedAt: string;
  /**
   * Per-comment-id dedup plus ISO `since=` cursors for the comments endpoints.
   * The comments endpoints use `since` with `>=` semantics, so the newest item
   * per batch reappears every tick; edited comments also resurface with a new
   * `updated_at`. Without ID tracking the same comment fires "New comment"
   * repeatedly. The pulls endpoint does NOT support `since`, so PR transitions
   * are tracked by the per-PR maps below instead.
   */
  readonly issueComments: DedupedResource<GhIssueComment> | undefined;
  readonly reviewComments: DedupedResource<GhReviewComment> | undefined;
  /**
   * Per-PR last-known state, indexed by PR number. Lets us emit a single
   * "opened" / "closed" / "merged" event per transition rather than every
   * time the PR shows up in the list endpoint.
   */
  readonly prStateByNumber: LRUCache<number, PullStateName>;
  /**
   * Per-PR `updated_at` cursor for the merge-conflict probe; only advanced
   * after a definite probe reading so a transient probe failure keeps the PR
   * a candidate next tick. See `probeMergeableStates`.
   */
  readonly prUpdatedAtByNumber: LRUCache<number, string>;
  /** Per-PR last *definite* `mergeable_state`; see `isDefiniteMergeableState`. */
  readonly prMergeableByNumber: LRUCache<number, string>;
}

/** Poll `repo` once from `prior`. */
export const pollRepo = Effect.fn('github.pollRepo')(function* (
  repo: RepoTarget,
  prior: RepoState | undefined,
) {
  const slug = targetPath(repo);
  const subscribedAt =
    prior?.subscribedAt ??
    new Date(yield* Clock.currentTimeMillis).toISOString();
  // The first poll's comment cursor: only events newer than this surface.
  const seedCursor = new Date(
    Date.parse(subscribedAt) - SEED_WINDOW_MS,
  ).toISOString();
  const since = (cursor: string | undefined) =>
    `&since=${encodeURIComponent(cursor ?? seedCursor)}`;
  const issuePath = `/repos/${repo.owner}/${repo.repo}/issues/comments?per_page=${PER_PAGE}${since(prior?.issueComments?.sinceCursor)}&sort=updated&direction=asc`;
  const reviewPath = `/repos/${repo.owner}/${repo.repo}/pulls/comments?per_page=${PER_PAGE}${since(prior?.reviewComments?.sinceCursor)}&sort=updated&direction=asc`;
  // The /pulls list endpoint does NOT support `since`; we get the top
  // 100 most-recently-updated PRs every tick. The `prStateByNumber`
  // transition tracker is what makes that safe.
  const pullsPath = `/repos/${repo.owner}/${repo.repo}/pulls?state=all&per_page=${PER_PAGE}&sort=updated&direction=desc`;

  const [rawIssueRes, rawReviewRes, rawPullsRes] = yield* Effect.all(
    [
      ghGet<unknown>(issuePath),
      ghGet<unknown>(reviewPath),
      ghGet<unknown>(pullsPath),
    ],
    { concurrency: 3 },
  );

  // One malformed payload skips the whole poll; the state is unchanged, so
  // the same window is evaluated again next tick.
  const skipped: PollResult<RepoState> = { next: prior, events: [] };
  const issueRes = yield* validateOrSkip(
    rawIssueRes,
    GhIssueCommentArraySchema,
    `Skipping ${slug} tick: issue-comments payload failed validation`,
  );
  if (!issueRes) return skipped;
  const reviewRes = yield* validateOrSkip(
    rawReviewRes,
    GhReviewCommentArraySchema,
    `Skipping ${slug} tick: review-comments payload failed validation`,
  );
  if (!reviewRes) return skipped;
  const pullsRes = yield* validateOrSkip(
    rawPullsRes,
    GhPullsListEntryArraySchema,
    `Skipping ${slug} tick: pulls-list payload failed validation`,
  );
  if (!pullsRes) return skipped;

  const prStateByNumber = prior
    ? copyLru(prior.prStateByNumber)
    : new LRUCache<number, PullStateName>({ max: MAX_PR_STATE_ENTRIES });
  const prUpdatedAtByNumber = prior
    ? copyLru(prior.prUpdatedAtByNumber)
    : new LRUCache<number, string>({ max: MAX_PR_STATE_ENTRIES });
  const prMergeableByNumber = prior
    ? copyLru(prior.prMergeableByNumber)
    : new LRUCache<number, string>({ max: MAX_PR_STATE_ENTRIES });
  const events: PollEvent[] = [];

  if (pullsRes.status === 200) {
    if (prior === undefined) {
      for (const pr of pullsRes.data) {
        prStateByNumber.set(pr.number, classifyPRState(pr));
        // Seed the updated_at cursor so the next tick only treats real
        // *advances* as probe triggers — without this the second tick
        // would see every PR's updated_at as "advanced" relative to
        // undefined and stampede MAX_PROBES probes on irrelevant PRs.
        prUpdatedAtByNumber.set(pr.number, pr.updated_at);
      }
    } else {
      // Emit PR transitions before comments so "PR opened" precedes any
      // reply. The API returns newest-first; reverse for chronological order.
      for (const pr of pullsRes.data.toReversed()) {
        const next = classifyPRState(pr);
        const prev = prStateByNumber.get(pr.number);
        prStateByNumber.set(pr.number, next);
        // Same author gate on both transitions: a bot-authored PR whose
        // open we suppressed shouldn't surface a close/merge orphan event.
        if (shouldDropBotEvent(pr.user)) continue;
        const transition = classifyTransition(prev, next, pr, subscribedAt);
        if (transition === 'opened') {
          events.push(formatRepoPROpened(repo, pr));
        } else if (transition === 'closed') {
          events.push(formatRepoPRClosed(repo, pr.number, next === 'merged'));
        }
      }
    }
  }

  // An item whose URL names no number is recorded but not reported.
  const issueComments = readNewItems(prior?.issueComments, issueRes, () =>
    dedupeComments<GhIssueComment>({ sinceCursor: seedCursor }),
  );
  for (const c of issueComments.fresh) {
    const number = parseTargetNumberFromIssueUrl(c);
    if (number !== undefined) {
      events.push(formatRepoIssueComment(repo, number, c));
    }
  }
  const reviewComments = readNewItems(prior?.reviewComments, reviewRes, () =>
    dedupeComments<GhReviewComment>({ sinceCursor: seedCursor }),
  );
  for (const c of reviewComments.fresh) {
    const prNumber = matchPositiveInt(PR_NUMBER_RE, c.html_url);
    if (prNumber !== undefined) {
      events.push(formatRepoReviewComment(repo, prNumber, c));
    }
  }
  // Bare APPROVED/DISMISSED reviews without comments aren't surfaced — they
  // live only on /pulls/{n}/reviews, which is per-PR. An orchestrator that
  // needs that fidelity should delegate a worker that subscribes to
  // path="owner/repo/pulls/N".

  // Holistic merge-conflict detection. The list endpoint doesn't return
  // `mergeable_state`, so we probe `/pulls/{N}` for a bounded number of
  // open PRs whose `updated_at` advanced since the prior tick. That
  // signal naturally covers head pushes (the most common cause of new
  // conflicts) and surfaces base-branch conflicts via the comments /
  // reviews that typically follow a base merge. PRs that don't make the
  // per-tick cap roll over: the next tick re-evaluates the candidate set.
  if (prior !== undefined && pullsRes.status === 200) {
    events.push(
      ...(yield* probeMergeableStates(repo, pullsRes.data, {
        prUpdatedAtByNumber,
        prMergeableByNumber,
      })),
    );
  }

  return {
    next: {
      subscribedAt,
      issueComments: issueComments.seen,
      reviewComments: reviewComments.seen,
      prStateByNumber,
      prUpdatedAtByNumber,
      prMergeableByNumber,
    },
    events,
  } satisfies PollResult<RepoState>;
});

/**
 * Probe up to `MAX_MERGEABLE_PROBES_PER_TICK` open PRs for
 * `mergeable_state` changes, prioritizing ones whose `updated_at`
 * advanced since the prior tick (with newest-first tie-breaking), and
 * record the readings in `maps`, the poll's next state.
 *
 * Reports one event per PR that flipped to `'dirty'`, or a single coalesced
 * summary if `>= MERGE_CONFLICT_COALESCE_THRESHOLD` PRs flipped on the
 * same tick. We do NOT emit "resolved" notifications at the repo level —
 * an orchestrator monitoring conflicts wants the alert, and the agent it
 * delegates the fix to will run a per-PR subscription that surfaces the
 * resolved transition. Adding it here would just spray noise.
 *
 * Skips bot-authored PRs end-to-end (mirrors the open/close gate above)
 * and PRs we've already classified as `'dirty'` so we don't re-emit
 * every time updated_at advances on an already-conflicted PR.
 */
const probeMergeableStates = Effect.fn('github.probeMergeableStates')(
  function* (
    repo: RepoTarget,
    pulls: readonly GhPullsListEntry[],
    maps: Pick<RepoState, 'prUpdatedAtByNumber' | 'prMergeableByNumber'>,
  ) {
    // Build the candidate list: open PRs whose updated_at advanced since
    // our last definite observation. First-seen PRs are seeded silently —
    // probing on first observation would surface "merge conflict detected"
    // for PRs that were already dirty before we attached. We update the
    // updated_at cursor only AFTER a successful probe so a transient probe
    // failure leaves the PR as a candidate next tick rather than waiting
    // for the next push to bring it back into scope.
    const candidates: GhPullsListEntry[] = [];
    for (const pr of pulls) {
      if (pr.state !== 'open') continue;
      if (shouldDropBotEvent(pr.user)) continue;
      const prevUpdatedAt = maps.prUpdatedAtByNumber.get(pr.number);
      if (prevUpdatedAt === undefined) {
        maps.prUpdatedAtByNumber.set(pr.number, pr.updated_at);
        continue;
      }
      if (pr.updated_at > prevUpdatedAt) candidates.push(pr);
    }
    if (candidates.length === 0) return [];

    // Pulls list is already sorted by updated_at desc, so slicing yields
    // the freshest candidates when the per-tick cap bites. Each probe
    // finishes on its own: one PR's failed GET must not drop the readings
    // of the others.
    const probeResults = yield* Effect.forEach(
      candidates.slice(0, MAX_MERGEABLE_PROBES_PER_TICK),
      (pr) => Effect.exit(probeOne(repo, pr)),
      { concurrency: 'unbounded' },
    );

    const newlyDirty: { number: number; prev: string }[] = [];
    for (const result of probeResults) {
      if (!Exit.isSuccess(result) || !result.value) continue;
      const { number, updatedAt, mergeable } = result.value;
      // Defer the cursor advance until we have a *definite* mergeable
      // reading. GitHub commonly returns `'unknown'` for a few seconds
      // after a push or base change while it computes mergeability;
      // advancing updated_at on that response would drop the PR from the
      // candidate set and let the subsequent dirty/clean transition slip
      // by silently.
      if (!isDefiniteMergeableState(mergeable)) continue;
      // `.set()` refreshes LRU recency so the cap evicts least-recently-touched
      // PRs, not first-seen ones.
      maps.prUpdatedAtByNumber.set(number, updatedAt);
      const prev = maps.prMergeableByNumber.get(number);
      maps.prMergeableByNumber.set(number, mergeable);
      // Silent seed on first definite reading; resolved transitions are
      // intentionally not surfaced at the repo level (see the doc above).
      if (!isDefiniteMergeableState(prev)) continue;
      if (mergeable === 'dirty' && prev !== 'dirty') {
        newlyDirty.push({ number, prev });
      }
    }

    if (newlyDirty.length >= MERGE_CONFLICT_COALESCE_THRESHOLD) {
      return [
        formatRepoMergeConflictSummary(
          repo,
          newlyDirty.map((d) => d.number),
        ),
      ];
    }
    return newlyDirty.map(({ number, prev }) =>
      formatRepoMergeConflictDetected(repo, number, prev),
    );
  },
);

/**
 * One PR's `mergeable_state` reading, or undefined when this tick cannot
 * establish one. A non-200, or a payload that fails validation, drops just
 * this probe rather than the whole poll: leaving the PR's `updated_at`
 * cursor un-advanced simply re-probes it next tick.
 */
const probeOne = Effect.fn('github.probeOne')(function* (
  repo: RepoTarget,
  pr: GhPullsListEntry,
) {
  const res = yield* ghGet<GhPullRequest>(
    `/repos/${repo.owner}/${repo.repo}/pulls/${pr.number}`,
  );
  if (res.status !== 200) return undefined;
  const parsed = Schema.decodeUnknownResult(GhPullRequestSchema)(res.data);
  if (!Result.isSuccess(parsed)) {
    yield* logWarning(
      `Skipping merge probe for ${targetPath(repo)}#${pr.number}: payload failed validation`,
      parsed.failure,
    );
    return undefined;
  }
  return {
    number: pr.number,
    updatedAt: pr.updated_at,
    mergeable: parsed.success.mergeable_state,
  };
});

function classifyPRState(pr: GhPullsListEntry): PullStateName {
  if (pr.state === 'open') return 'open';
  return pr.merged_at ? 'merged' : 'closed';
}

/**
 * Returns the user-visible transition (or none) for a PR state change.
 * - Reopens (closed/merged → open) → "opened".
 * - Open → closed/merged → "closed".
 * - First-seen open PRs: only "opened" if `created_at > subscribedAt`,
 *   otherwise the PR predates the subscription and just bubbled into the
 *   top-100-updated window — recording silently is correct.
 * - First-seen closed/merged PRs: silent (predate the subscription).
 */
function classifyTransition(
  prev: PullStateName | undefined,
  next: PullStateName,
  pr: GhPullsListEntry,
  subscribedAt: string,
): 'opened' | 'closed' | 'none' {
  if (prev === undefined) {
    if (next === 'open' && pr.created_at > subscribedAt) return 'opened';
    return 'none';
  }
  if (prev === next) return 'none';
  if (next === 'open') return 'opened';
  return 'closed';
}

/**
 * Extract the issue/PR number for an item from `/issues/comments`. The
 * endpoint returns comments on both issues and PRs (a PR conversation tab
 * comment is stored as an issue comment internally), and the `html_url` is
 * not a reliable discriminator across cases. `issue_url` is always present
 * and canonical: `https://api.github.com/repos/o/r/issues/{number}`.
 */
const ISSUE_URL_NUMBER_RE = /\/issues\/(\d+)(?:[?#]|$)/;

/** Run a capture-group-1 regex against a URL and parse the match as a finite number. */
function matchPositiveInt(re: RegExp, url: string): number | undefined {
  const m = re.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function parseTargetNumberFromIssueUrl(c: GhIssueComment): number | undefined {
  const url = c.issue_url ?? c.html_url;
  const issueNumber = matchPositiveInt(ISSUE_URL_NUMBER_RE, url);
  if (issueNumber !== undefined) return issueNumber;
  // Fallback: review comments and certain PR-only flows expose `/pull/{n}`.
  return matchPositiveInt(PR_NUMBER_RE, url);
}

/**
 * Review-thread comments (`/pulls/comments`) always live on a PR; their
 * `html_url` is `…/pull/{number}#discussion_r…`.
 */
const PR_NUMBER_RE = /\/pull\/(\d+)(?:[?#/]|$)/;
