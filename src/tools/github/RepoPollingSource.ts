/**
 * Coarse-grained event source for whole-repo GitHub activity.
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
 *   `github_subscription` with `path="owner/repo#N"`.
 * - **Issue open/close transitions.** Only PR transitions are tracked.
 *   Issue conversation comments do flow through.
 * - **Bare APPROVED / DISMISSED reviews without comments.** Live only on
 *   `/pulls/{n}/reviews`; per-PR by design.
 * - **CI / check-run status and inline annotations.** Per-PR by design.
 */

import { bus } from '@eventBus/ProgressEventBus';

import { shouldDropBotEvent } from './botFilter';
import {
  formatRepoIssueComment,
  formatRepoMergeConflictDetected,
  formatRepoMergeConflictSummary,
  formatRepoPRClosed,
  formatRepoPROpened,
  formatRepoReviewComment,
  formatRepoSubscriptionError,
} from './formatRepoEvent';
import { getNewestTimestamp, trimSet } from './formatUtils';
import { ghGet } from './githubClient';
import {
  PollingSourceBase,
  type BasePollSubscriptionState,
  type Disposable,
} from './PollingSourceBase';
import type {
  GhIssueComment,
  GhPullRequest,
  GhPullsListEntry,
  GhReviewComment,
} from './prTypes';

// We pull all "updated since" data; a sufficiently large window guarantees we
// catch transitions even after a brief network outage. GitHub caps these
// endpoints at 100 per page; we don't paginate — if more than 100 events
// happened in a 30s tick, the orchestrator was about to be overwhelmed
// anyway and missing some is a feature, not a bug.
const PER_PAGE = 100;
// Initial seed window when first subscribing: only events newer than this are
// surfaced. Without it the very first tick would replay the entire backlog.
const SEED_WINDOW_MS = 60_000;
// Cap on `prStateByNumber` to keep long-lived subscriptions on busy repos
// from accumulating an entry per PR ever seen. FIFO eviction by Map
// insertion order; touched PRs are re-inserted at the tail so closed-and-
// forgotten PRs roll off first.
const MAX_PR_STATE_ENTRIES = 500;
// Cap on the per-comment seen-id sets, mirroring PRPollingSource. Events
// older than this fall out of the dedup window — but the `since` cursor
// will normally have advanced past them by then anyway.
const MAX_SEEN_IDS = 1000;
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

export type RepoKey = `${string}/${string}`;

export function repoKeyOf(owner: string, repo: string): RepoKey {
  return `${owner}/${repo}` as RepoKey;
}

interface SubscriptionState extends BasePollSubscriptionState {
  owner: string;
  repo: string;
  slug: RepoKey;
  initialized: boolean;
  /**
   * ISO timestamp of when the subscription started. Used to gate "PR opened"
   * emission: a first-seen open PR is only treated as newly opened if its
   * `created_at` post-dates this; otherwise it's a backfill (an older PR
   * that just bubbled into the top-100-updated window) and recorded
   * silently.
   */
  subscribedAt: string;
  /**
   * ISO timestamps for `since=` filtering on the comments endpoints. Advanced
   * to the newest seen item after each successful tick so we don't replay
   * history. The pulls endpoint does NOT support `since` (only `state`,
   * `head`, `base`, `sort`, `direction`, `per_page`, `page`), so we don't
   * track a cursor for it.
   */
  since: {
    issueComments: string;
    reviewComments: string;
  };
  /**
   * Per-comment-id dedup. The comments endpoints use `since` with `>=`
   * semantics, so the newest item per batch reappears every tick; edited
   * comments also resurface with a new `updated_at`. Without ID-tracking
   * the same comment fires "New comment" repeatedly. Trimmed to MAX_SEEN_IDS.
   */
  seenIssueCommentIds: Set<number>;
  seenReviewCommentIds: Set<number>;
  /**
   * Per-PR last-known state, indexed by PR number. Lets us emit a single
   * "opened" / "closed" / "merged" event per transition rather than every
   * time the PR shows up in the list endpoint.
   */
  prStateByNumber: Map<number, 'open' | 'closed' | 'merged'>;
  /**
   * Last seen `updated_at` from the pulls list per PR. Used to drive the
   * holistic merge-conflict probe: an advanced `updated_at` is a (necessary
   * but not sufficient) signal that head was pushed or the base shifted,
   * either of which can change `mergeable_state`. We probe `/pulls/{N}`
   * only for PRs whose updated_at advanced since the prior tick — which
   * naturally covers head pushes, and catches base-branch effects via the
   * comment / review activity that typically follows a merge into base.
   */
  prUpdatedAtByNumber: Map<number, string>;
  /**
   * Last observed *definite* `mergeable_state` per PR (we never store
   * `'unknown'` — see `isDefiniteMergeableState` in PRPollingSource for
   * the same reasoning). Indexed by PR number; entries roll off with
   * `prStateByNumber` via shared FIFO eviction.
   */
  prMergeableByNumber: Map<number, string>;
}

export class RepoPollingSource extends PollingSourceBase<
  RepoKey,
  SubscriptionState
> {
  constructor() {
    super({
      // Repo-scoped polling fans out to every active PR in the repo via three
      // shared endpoints. With 5,000 req/hr per token and ~3 GETs per repo
      // per tick (every 30s = 120 ticks/hr), one repo costs ~360 req/hr;
      // 3 repos ≈ 1,080 req/hr — well below the limit even sharing with a
      // couple of per-PR pollers.
      name: 'RepoPollingSource',
      pollIntervalMs: 30_000,
      maxConcurrent: 3,
      backoffBaseMs: 60_000,
      backoffMaxMs: 3_600_000,
      maxFailureDurationMs: 24 * 3_600_000,
    });
  }

  subscribe(
    owner: string,
    repo: string,
    onEvent: (text: string) => void,
  ): Disposable {
    const key = repoKeyOf(owner, repo);
    return this.register(key, () => createInitialState(owner, repo), onEvent);
  }

  protected emitKeysChangedBusEvent(keys: readonly RepoKey[]): void {
    bus.emit('repoSubscriptionsChanged', { keys });
  }

  protected formatErrorEvent(
    _key: RepoKey,
    state: SubscriptionState,
    detail: string,
  ): string {
    return formatRepoSubscriptionError(state.slug, detail);
  }

  protected async pollOne(
    _key: RepoKey,
    state: SubscriptionState,
  ): Promise<void> {
    const { owner, repo } = state;
    const issuePath = `/repos/${owner}/${repo}/issues/comments?per_page=${PER_PAGE}&since=${encodeURIComponent(state.since.issueComments)}&sort=updated&direction=asc`;
    const reviewPath = `/repos/${owner}/${repo}/pulls/comments?per_page=${PER_PAGE}&since=${encodeURIComponent(state.since.reviewComments)}&sort=updated&direction=asc`;
    // The /pulls list endpoint does NOT support `since`; we get the top
    // 100 most-recently-updated PRs every tick. The `prStateByNumber`
    // transition tracker is what makes that safe.
    const pullsPath = `/repos/${owner}/${repo}/pulls?state=all&per_page=${PER_PAGE}&sort=updated&direction=desc`;

    const [issueRes, reviewRes, pullsRes] = await Promise.all([
      ghGet<GhIssueComment[]>(issuePath),
      ghGet<GhReviewComment[]>(reviewPath),
      ghGet<GhPullsListEntry[]>(pullsPath),
    ]);

    // First tick seeds state but emits nothing — we don't want to replay
    // history when an orchestrator first attaches to a repo.
    if (!state.initialized) {
      if (pullsRes.status === 200) {
        for (const pr of pullsRes.data) {
          state.prStateByNumber.set(pr.number, classifyPRState(pr));
          // Seed the updated_at cursor so the next tick only treats real
          // *advances* as probe triggers — without this the second tick
          // would see every PR's updated_at as "advanced" relative to
          // undefined and stampede MAX_PROBES probes on irrelevant PRs.
          state.prUpdatedAtByNumber.set(pr.number, pr.updated_at);
        }
      }
      if (issueRes.status === 200) {
        for (const c of issueRes.data) state.seenIssueCommentIds.add(c.id);
        const newest = getNewestTimestamp(issueRes.data);
        if (newest) state.since.issueComments = newest;
      }
      if (reviewRes.status === 200) {
        for (const c of reviewRes.data) state.seenReviewCommentIds.add(c.id);
        const newest = getNewestTimestamp(reviewRes.data);
        if (newest) state.since.reviewComments = newest;
      }
      state.initialized = true;
      return;
    }

    // Emit PR transitions before comments so "PR opened" precedes any reply.
    if (pullsRes.status === 200) {
      // API returns newest-first; reverse for chronological notification order.
      const sorted = [...pullsRes.data].reverse();
      for (const pr of sorted) {
        const next = classifyPRState(pr);
        const prev = state.prStateByNumber.get(pr.number);
        const transition = classifyTransition(
          prev,
          next,
          pr,
          state.subscribedAt,
        );
        // Same author gate on both transitions: a bot-authored PR whose
        // open we suppressed shouldn't surface a close/merge orphan event.
        if (shouldDropBotEvent(pr.user)) {
          // fall through to record state
        } else if (transition === 'opened') {
          this.emit(state, formatRepoPROpened(state.slug, pr));
        } else if (transition === 'closed') {
          this.emit(
            state,
            formatRepoPRClosed(state.slug, pr.number, next === 'merged'),
          );
        }
        // FIFO eviction relies on Map insertion order; delete-then-set
        // re-inserts at the tail so recently-touched PRs are kept.
        state.prStateByNumber.delete(pr.number);
        state.prStateByNumber.set(pr.number, next);
      }
      while (state.prStateByNumber.size > MAX_PR_STATE_ENTRIES) {
        const oldest = state.prStateByNumber.keys().next().value;
        if (oldest === undefined) break;
        state.prStateByNumber.delete(oldest);
      }
    }

    if (issueRes.status === 200) {
      for (const c of issueRes.data) {
        if (state.seenIssueCommentIds.has(c.id)) continue;
        state.seenIssueCommentIds.add(c.id);
        const number = parseTargetNumberFromIssueUrl(c);
        if (number === undefined) continue;
        if (shouldDropBotEvent(c.user)) continue;
        this.emit(state, formatRepoIssueComment(state.slug, number, c));
      }
      trimSet(state.seenIssueCommentIds, MAX_SEEN_IDS);
      const newest = getNewestTimestamp(issueRes.data);
      if (newest) state.since.issueComments = newest;
    }

    if (reviewRes.status === 200) {
      for (const c of reviewRes.data) {
        if (state.seenReviewCommentIds.has(c.id)) continue;
        state.seenReviewCommentIds.add(c.id);
        const prNumber = parsePRNumberFromReviewCommentUrl(c.html_url);
        if (prNumber === undefined) continue;
        if (shouldDropBotEvent(c.user)) continue;
        this.emit(state, formatRepoReviewComment(state.slug, prNumber, c));
      }
      trimSet(state.seenReviewCommentIds, MAX_SEEN_IDS);
      const newest = getNewestTimestamp(reviewRes.data);
      if (newest) state.since.reviewComments = newest;
    }
    // Bare APPROVED/DISMISSED reviews without comments aren't surfaced — they
    // live only on /pulls/{n}/reviews, which is per-PR. An orchestrator that
    // needs that fidelity should delegate a worker that calls
    // github_subscription with path="owner/repo#N".

    // Holistic merge-conflict detection. The list endpoint doesn't return
    // `mergeable_state`, so we probe `/pulls/{N}` for a bounded number of
    // open PRs whose `updated_at` advanced since the prior tick. That
    // signal naturally covers head pushes (the most common cause of new
    // conflicts) and surfaces base-branch conflicts via the comments /
    // reviews that typically follow a base merge. PRs that don't make the
    // per-tick cap roll over: the next tick re-evaluates the candidate set.
    if (pullsRes.status === 200) {
      await this.probeMergeableStates(state, pullsRes.data);
    }
  }

  /**
   * Probe up to `MAX_MERGEABLE_PROBES_PER_TICK` open PRs for
   * `mergeable_state` changes, prioritizing ones whose `updated_at`
   * advanced since the prior tick (with newest-first tie-breaking).
   *
   * Emits one event per PR that flipped to `'dirty'`, or a single coalesced
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
  private async probeMergeableStates(
    state: SubscriptionState,
    pulls: readonly GhPullsListEntry[],
  ): Promise<void> {
    // Build the candidate list: open PRs whose updated_at advanced (or is
    // first-seen as open). Order by updated_at desc so the freshest wins
    // when the per-tick cap bites. The pulls list is already newest-first
    // by sort=updated&direction=desc — preserve that order.
    const candidates: GhPullsListEntry[] = [];
    for (const pr of pulls) {
      if (pr.state !== 'open') continue;
      if (shouldDropBotEvent(pr.user)) continue;
      const prevUpdatedAt = state.prUpdatedAtByNumber.get(pr.number);
      // Always record the latest updated_at so the next tick's "advanced"
      // detection is correct — but only QUEUE a probe when we observed an
      // advance. Without this we'd probe every open PR every tick.
      const advanced =
        prevUpdatedAt === undefined || pr.updated_at > prevUpdatedAt;
      state.prUpdatedAtByNumber.set(pr.number, pr.updated_at);
      // First-seen-after-init: predates our subscription; record updated_at
      // and the next pulls-list response with a real change will bring it
      // back as a candidate. Probing on first observation would silently
      // emit for PRs that were already dirty when we attached.
      if (prevUpdatedAt === undefined) continue;
      if (!advanced) continue;
      candidates.push(pr);
    }
    if (candidates.length === 0) return;

    const probes = candidates.slice(0, MAX_MERGEABLE_PROBES_PER_TICK);
    // Run probes in parallel — each is one independent GET, the budget cap
    // is small (<=5), and serializing would multiply tick latency.
    const probeResults = await Promise.allSettled(
      probes.map(async (pr) => {
        const path = `/repos/${state.owner}/${state.repo}/pulls/${pr.number}`;
        const res = await ghGet<GhPullRequest>(path);
        if (res.status !== 200) return undefined;
        return { number: pr.number, mergeable: res.data.mergeable_state };
      }),
    );
    // Capture (number, prev, next) for newly-dirty PRs *before* writing back
    // to the map — otherwise the per-PR formatter's "(was X)" hint would
    // read the just-overwritten value.
    const newlyDirty: { number: number; prev: string }[] = [];
    for (const result of probeResults) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { number, mergeable } = result.value;
      if (!isDefiniteMergeableState(mergeable)) continue;
      const prev = state.prMergeableByNumber.get(number);
      state.prMergeableByNumber.set(number, mergeable);
      if (!isDefiniteMergeableState(prev)) {
        // First definite reading — silent seed. Same reasoning as the per-PR
        // poller: we don't want to surface "merge conflict detected" for a
        // PR that was already dirty before we observed it.
        continue;
      }
      if (mergeable === 'dirty' && prev !== 'dirty') {
        newlyDirty.push({ number, prev });
      }
      // Resolved transitions are intentionally not emitted at the repo level
      // — see method-level comment.
    }

    if (newlyDirty.length >= MERGE_CONFLICT_COALESCE_THRESHOLD) {
      this.emit(
        state,
        formatRepoMergeConflictSummary(
          state.slug,
          newlyDirty.map((d) => d.number),
        ),
      );
    } else {
      for (const { number, prev } of newlyDirty) {
        this.emit(
          state,
          formatRepoMergeConflictDetected(state.slug, number, prev),
        );
      }
    }
    // Bound `prMergeableByNumber` against unbounded growth on long-lived
    // subscriptions watching busy repos. FIFO mirrors `prStateByNumber`'s
    // policy: closed-and-forgotten PRs roll off first because they stop
    // being re-inserted by the probe loop. Cap matches MAX_PR_STATE_ENTRIES
    // so the two maps age out at roughly the same rate.
    while (state.prMergeableByNumber.size > MAX_PR_STATE_ENTRIES) {
      const oldest = state.prMergeableByNumber.keys().next().value;
      if (oldest === undefined) break;
      state.prMergeableByNumber.delete(oldest);
    }
    while (state.prUpdatedAtByNumber.size > MAX_PR_STATE_ENTRIES) {
      const oldest = state.prUpdatedAtByNumber.keys().next().value;
      if (oldest === undefined) break;
      state.prUpdatedAtByNumber.delete(oldest);
    }
  }
}

function createInitialState(owner: string, repo: string): SubscriptionState {
  const now = Date.now();
  const seed = new Date(now - SEED_WINDOW_MS).toISOString();
  return {
    owner,
    repo,
    slug: repoKeyOf(owner, repo),
    listeners: new Set(),
    initialized: false,
    subscribedAt: new Date(now).toISOString(),
    since: {
      issueComments: seed,
      reviewComments: seed,
    },
    seenIssueCommentIds: new Set(),
    seenReviewCommentIds: new Set(),
    prStateByNumber: new Map(),
    prUpdatedAtByNumber: new Map(),
    prMergeableByNumber: new Map(),
    lastSuccessAt: now,
    consecutiveFailures: 0,
    skipPollUntilMs: 0,
  };
}

/** Mirrors the PR poller's filter: anything but `'unknown'` is "definite". */
function isDefiniteMergeableState(s: string | undefined): s is string {
  return s !== undefined && s !== 'unknown';
}

function classifyPRState(pr: GhPullsListEntry): 'open' | 'closed' | 'merged' {
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
  prev: 'open' | 'closed' | 'merged' | undefined,
  next: 'open' | 'closed' | 'merged',
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
function parseTargetNumberFromIssueUrl(c: GhIssueComment): number | undefined {
  const url = c.issue_url ?? c.html_url;
  const m = ISSUE_URL_NUMBER_RE.exec(url);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  // Fallback: review comments and certain PR-only flows expose `/pull/{n}`.
  const p = /\/pull\/(\d+)(?:[?#/]|$)/.exec(url);
  if (!p) return undefined;
  const n = Number(p[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Review-thread comments (`/pulls/comments`) always live on a PR; their
 * `html_url` is `…/pull/{number}#discussion_r…`.
 */
const PR_NUMBER_RE = /\/pull\/(\d+)(?:[?#/]|$)/;
function parsePRNumberFromReviewCommentUrl(url: string): number | undefined {
  const m = PR_NUMBER_RE.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Process-wide singleton. */
export const repoPollingSource = new RepoPollingSource();
