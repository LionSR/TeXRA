/**
 * Poll-based {@link AsyncEventSource} for GitHub PR activity.
 *
 * Each subscribed PR maintains per-resource cursors (last-seen ID) and ETags.
 * A single shared timer ticks every `POLL_INTERVAL_MS` and iterates all active
 * subscriptions. Events are converted to natural-language text via
 * `formatPREvent` and dispatched to per-caller listeners.
 *
 * Transport is polling for v1; swapping to a push transport (e.g. a Supabase
 * edge function fan-out) would replace this file without affecting the tool
 * layer above.
 */

import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';

import {
  formatCheckFailure,
  formatCheckFailureSummary,
  formatCIComplete,
  formatCIPassed,
  formatIssueComment,
  formatPRClosed,
  formatReview,
  formatReviewComment,
  formatSubscriptionError,
  isPassingConclusion,
} from './formatPREvent';
import {
  GitHubAuthError,
  GitHubRateLimitError,
  type ConditionalResponse,
  ghGet,
} from './githubClient';
import type { AsyncEventSource, Disposable } from './AsyncEventSource';
import type {
  GhCheckRun,
  GhIssueComment,
  GhPullRequest,
  GhReview,
  GhReviewComment,
} from './prTypes';

const POLL_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_SUBSCRIPTIONS = 10;
// Coalesce this many same-kind events in a single tick into a summary.
const COALESCE_THRESHOLD = 3;
// Per-resource id history is trimmed to this many entries so long-running
// subscriptions don't grow the state map unboundedly.
const MAX_SEEN_IDS = 1000;
// GitHub caps the check-runs endpoint at 100 per page.
const CHECK_RUNS_PAGE_SIZE = 100;
// Hard ceiling on how many check-runs pages we'll walk in a single fetch.
// 50 pages = 5,000 runs — well above any realistic monorepo matrix build.
// Without a cap a malformed/runaway `total_count` could fan out into
// hundreds of GETs per tick.
const MAX_CHECK_RUNS_PAGES = 50;

export interface PRKey {
  owner: string;
  repo: string;
  pullNumber: number;
}

export function prKeyToString(k: PRKey): string {
  return `${k.owner}/${k.repo}#${k.pullNumber}`;
}

export function parsePRKey(key: string): PRKey {
  const match = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) throw new Error(`Invalid PR key: ${key}`);
  return {
    owner: match[1],
    repo: match[2],
    pullNumber: Number(match[3]),
  };
}

function withSince(url: string, since: string | undefined): string {
  if (!since) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}since=${encodeURIComponent(since)}`;
}

/** Return the newest `updated_at` (falling back to `created_at`) in the batch. */
function newestTimestamp(
  items: ReadonlyArray<{
    created_at?: string | null;
    updated_at?: string | null;
  }>,
): string | undefined {
  let best: string | undefined;
  for (const it of items) {
    const t = it.updated_at ?? it.created_at ?? undefined;
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

interface SubscriptionState {
  pr: PRKey;
  slug: string;
  listeners: Set<(text: string) => void>;
  // Per-resource pagination / cursor state. Initialized on first tick so we
  // do not replay historical events.
  initialized: boolean;
  seenIssueCommentIds: Set<number>;
  seenReviewCommentIds: Set<number>;
  seenReviewIds: Set<number>;
  lastFailedCheckKeys: Set<string>;
  /** Head SHA for which the one-shot "CI complete" event has been emitted. */
  ciCompleteSha: string | undefined;
  /** Head SHA for which the one-shot "CI passed" event has been emitted. */
  ciPassedSha: string | undefined;
  headSha: string | undefined;
  state: 'open' | 'closed' | undefined;
  merged: boolean;
  // ETags for conditional requests.
  etags: {
    pr?: string;
    issueComments?: string;
    reviewComments?: string;
    reviews?: string;
  };
  /**
   * Per-page cache for the paginated check-runs endpoint.
   *
   * Single-page PRs (<=100 runs) only ever touch page 1, so this still gives
   * us the cheap 304 path. Multi-page PRs (>100 runs) issue conditional GETs
   * per page; pages that haven't changed return 304 and we reuse the cached
   * `check_runs` for that page. This is what keeps the polling cost bounded
   * on large matrix builds — a steady-state tick should be N HEAD-cheap 304s,
   * not N unconditional full-page GETs.
   *
   * `lastTotalCount` is the most recent `total_count` we saw from a 200
   * response; it lets us decide how many pages to walk on a tick where
   * page 1 came back 304.
   */
  checkRunsCache?: {
    etagsByPage: Map<number, string>;
    pagesByPage: Map<number, GhCheckRun[]>;
    lastTotalCount: number;
  };
  // ISO `since` cursors for server-side filtering on the comments endpoints.
  // Advance to the newest seen item's timestamp so PRs with >100 comments
  // still surface new activity (default sort is oldest-first; without
  // `since` the recent items fall off the first page).
  sinceCursors: {
    issueComments?: string;
    reviewComments?: string;
  };
  consecutiveFailures: number;
  /** Epoch-ms until which this subscription skips polling (rate-limit backoff). */
  skipPollUntilMs: number;
}

export class PRPollingSource implements AsyncEventSource {
  private readonly logger = new AgentLogger('PRPollingSource');
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly changeListeners = new Set<
    (keys: readonly string[]) => void
  >();
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Register a callback fired whenever the set of active PR keys changes
   * (subscription added, removed, auto-unsubscribed on close, etc.). Used by
   * the settings UI to keep its active-subscriptions list in sync.
   */
  onKeysChanged(listener: (keys: readonly string[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyKeysChanged(): void {
    const snapshot = [...this.subscriptions.keys()];
    bus.emit('prSubscriptionsChanged', { keys: snapshot });
    for (const cb of this.changeListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        this.logger.warn(`Change listener threw: ${String(err)}`);
      }
    }
  }

  subscribe(key: string, onEvent: (text: string) => void): Disposable {
    const pr = parsePRKey(key);
    const slug = `${pr.owner}/${pr.repo}`;

    let state = this.subscriptions.get(key);
    if (!state) {
      if (this.subscriptions.size >= MAX_CONCURRENT_SUBSCRIPTIONS) {
        throw new Error(
          `Too many active PR subscriptions (max ${MAX_CONCURRENT_SUBSCRIPTIONS}). Unsubscribe from one before adding another.`,
        );
      }
      state = {
        pr,
        slug,
        listeners: new Set(),
        initialized: false,
        seenIssueCommentIds: new Set(),
        seenReviewCommentIds: new Set(),
        seenReviewIds: new Set(),
        lastFailedCheckKeys: new Set(),
        ciCompleteSha: undefined,
        ciPassedSha: undefined,
        headSha: undefined,
        state: undefined,
        merged: false,
        etags: {},
        sinceCursors: {},
        consecutiveFailures: 0,
        skipPollUntilMs: 0,
      };
      this.subscriptions.set(key, state);
      this.logger.info(`Subscribed to ${key}`);
      this.notifyKeysChanged();
    }
    state.listeners.add(onEvent);
    this.ensureTimer();

    return {
      dispose: () => this.removeListener(key, onEvent),
    };
  }

  activeKeys(): readonly string[] {
    return [...this.subscriptions.keys()];
  }

  private removeListener(key: string, onEvent: (text: string) => void): void {
    const state = this.subscriptions.get(key);
    if (!state) return;
    state.listeners.delete(onEvent);
    if (state.listeners.size === 0) {
      this.subscriptions.delete(key);
      this.logger.info(`Unsubscribed from ${key}`);
      this.notifyKeysChanged();
    }
    if (this.subscriptions.size === 0) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    // Fire an immediate tick so first-subscribe initializes cursors without
    // waiting a full interval.
    void this.tick();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tickInFlight = false;

  private async tick(): Promise<void> {
    // setInterval fires every POLL_INTERVAL_MS regardless of prior
    // completion; with N subscriptions and 15s per-request timeouts a tick
    // can outlast the interval. Without this guard overlapping ticks would
    // double-emit events for the same new items.
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = Date.now();
      const entries = [...this.subscriptions.entries()];
      await Promise.allSettled(
        entries.map(async ([key, state]) => {
          if (state.skipPollUntilMs > now) return;
          try {
            await this.pollOne(state);
            state.consecutiveFailures = 0;
          } catch (err) {
            if (err instanceof GitHubAuthError) {
              this.logger.warn(
                `Auth error for ${key}; stopping subscription. ${err.message}`,
              );
              this.emit(
                state,
                formatSubscriptionError(
                  state.slug,
                  state.pr.pullNumber,
                  err.message,
                ),
              );
              this.subscriptions.delete(key);
              this.notifyKeysChanged();
              bus.emit('githubTokenInvalid', { message: err.message });
            } else if (err instanceof GitHubRateLimitError) {
              // Rate limiting is a transient, expected condition; don't let
              // it inflate consecutiveFailures (which trips the
              // "halted after repeated failures" auto-unsubscribe).
              state.skipPollUntilMs = err.resetAt * 1000;
              this.logger.warn(
                `Rate limited while polling ${key}; backing off until ${new Date(state.skipPollUntilMs).toISOString()}.`,
              );
            } else {
              state.consecutiveFailures += 1;
              this.logger.warn(
                `Poll failed for ${key} (${state.consecutiveFailures} in a row): ${String(err)}`,
              );
              if (state.consecutiveFailures >= 5) {
                this.emit(
                  state,
                  formatSubscriptionError(
                    state.slug,
                    state.pr.pullNumber,
                    `repeated failures: ${String(err)}`,
                  ),
                );
                this.subscriptions.delete(key);
                this.notifyKeysChanged();
              }
            }
          }
        }),
      );
      if (this.subscriptions.size === 0) this.stopTimer();
    } finally {
      this.tickInFlight = false;
    }
  }

  private trimSet<T>(set: Set<T>): void {
    const excess = set.size - MAX_SEEN_IDS;
    if (excess <= 0) return;
    const iter = set.values();
    for (let i = 0; i < excess; i += 1) set.delete(iter.next().value as T);
  }

  private emit(state: SubscriptionState, text: string): void {
    for (const cb of state.listeners) {
      try {
        cb(text);
      } catch (err) {
        this.logger.warn(
          `Listener threw for ${prKeyToString(state.pr)}: ${String(err)}`,
        );
      }
    }
  }

  private async pollOne(state: SubscriptionState): Promise<void> {
    const { pr } = state;
    const prPath = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pullNumber}`;
    const issuePath = `/repos/${pr.owner}/${pr.repo}/issues/${pr.pullNumber}`;

    const prRes = await ghGet<GhPullRequest>(prPath, state.etags.pr);
    if (prRes.status === 200) {
      state.etags.pr = prRes.etag;
      const newHead = prRes.data.head.sha;
      const newState = prRes.data.state;
      const newMerged = prRes.data.merged;

      // Detect close/merge on initialized subscriptions.
      if (
        state.initialized &&
        state.state === 'open' &&
        newState === 'closed'
      ) {
        this.emit(state, formatPRClosed(state.slug, pr.pullNumber, newMerged));
        // Auto-unsubscribe.
        this.subscriptions.delete(prKeyToString(pr));
        this.notifyKeysChanged();
        return;
      }
      state.state = newState;
      state.merged = newMerged;
      // New push invalidates prior CI terminal state — the next completion
      // on the new SHA should re-emit both terminal events. Also drop the
      // per-page check-runs cache: it's keyed only by page number, and the
      // ETags from the previous SHA can never match the new SHA's responses.
      // Letting it linger would cost one wasted If-None-Match per page on
      // the first post-push tick before the cache naturally refreshes.
      if (state.headSha !== newHead) {
        state.ciCompleteSha = undefined;
        state.ciPassedSha = undefined;
        state.checkRunsCache = undefined;
      }
      state.headSha = newHead;
    }

    // Bail cleanly if the PR is already closed. On the first (initialization)
    // tick this prevents a zombie subscription: without this branch the
    // subscription would stay in the map forever, burning an API call every
    // 30s and a slot in the concurrent-subscription cap, because the
    // open→closed auto-unsubscribe transition above never fires for a PR
    // that was closed before we started watching.
    if (state.state === 'closed') {
      // Defense-in-depth: auto-unsubscribe whenever we land here while
      // still tracked, not only on `!initialized`. The open→closed
      // transition above is the primary path, but this covers any edge
      // (future refactors, unexpected state) where we could otherwise
      // return early every tick without ever cleaning up.
      const prKey = prKeyToString(pr);
      if (this.subscriptions.has(prKey)) {
        this.emit(
          state,
          formatPRClosed(state.slug, pr.pullNumber, state.merged),
        );
        this.subscriptions.delete(prKey);
        this.notifyKeysChanged();
      }
      state.initialized = true;
      return;
    }

    const issueCommentsUrl = withSince(
      `${issuePath}/comments?per_page=100`,
      state.sinceCursors.issueComments,
    );
    const reviewCommentsUrl = withSince(
      `${prPath}/comments?per_page=100`,
      state.sinceCursors.reviewComments,
    );
    const [commentsRes, reviewCommentsRes, reviewsRes, checksOutcome] =
      await Promise.all([
        ghGet<GhIssueComment[]>(issueCommentsUrl, state.etags.issueComments),
        ghGet<GhReviewComment[]>(reviewCommentsUrl, state.etags.reviewComments),
        ghGet<GhReview[]>(
          `${prPath}/reviews?per_page=100`,
          state.etags.reviews,
        ),
        state.headSha
          ? this.fetchAllCheckRuns(pr.owner, pr.repo, state.headSha, state)
          : Promise.resolve({
              response: { status: 304 as const },
              stagedCache: undefined,
            }),
      ]);
    // Destructure separately so we can commit `stagedCache` only at the end
    // of the success path (after the diff branch). If a sibling rejection
    // had thrown above, the cache would not have been advanced — preventing
    // a stale cache + 304 next tick from silently swallowing check-run
    // transitions.
    const checksRes = checksOutcome.response;
    const stagedCheckRunsCache = checksOutcome.stagedCache;

    // First tick only seeds cursors so we never replay history.
    if (!state.initialized) {
      if (commentsRes.status === 200) {
        state.etags.issueComments = commentsRes.etag;
        for (const c of commentsRes.data) state.seenIssueCommentIds.add(c.id);
        state.sinceCursors.issueComments = newestTimestamp(commentsRes.data);
      }
      if (reviewCommentsRes.status === 200) {
        state.etags.reviewComments = reviewCommentsRes.etag;
        for (const c of reviewCommentsRes.data)
          state.seenReviewCommentIds.add(c.id);
        state.sinceCursors.reviewComments = newestTimestamp(
          reviewCommentsRes.data,
        );
      }
      if (reviewsRes.status === 200) {
        state.etags.reviews = reviewsRes.etag;
        // Skip PENDING: these are the authenticated user's own drafts
        // (only visible via their own token). A review keeps the same ID
        // when it transitions PENDING → APPROVED/CHANGES_REQUESTED/COMMENTED,
        // so if we seed the pending id here the actual submission will be
        // silently deduped later.
        for (const r of reviewsRes.data) {
          if (r.state !== 'PENDING') state.seenReviewIds.add(r.id);
        }
      }
      if (checksRes.status === 200) {
        // ETag/page caching is owned by `fetchAllCheckRuns` via
        // `state.checkRunsCache`; nothing to record on `state.etags` here.
        const runs = checksRes.data.check_runs;
        for (const r of runs) {
          if (this.isCheckFailure(r)) {
            state.lastFailedCheckKeys.add(this.checkKey(r));
          }
        }
        // Seed so pre-existing terminal CI doesn't fire on the next tick —
        // we only surface transitions that happen after subscribe. Gate on
        // runs.length > 0: an empty array is ambiguous (no CI configured vs.
        // runs not yet registered), so "done" isn't meaningful and seeding
        // would suppress the real terminal event once runs appear. Also
        // require we have the full set (length >= total_count). The runs
        // array from fetchAllCheckRuns is deduped by id and total_count is
        // the latest server-reported value, so this comparison is safe
        // against mid-walk page shifts that would otherwise let a duplicate-
        // padded array trip the gate before a newly-registered run was seen.
        if (
          state.headSha &&
          runs.length > 0 &&
          runs.length >= checksRes.data.total_count &&
          runs.every((r) => r.status === 'completed')
        ) {
          state.ciCompleteSha = state.headSha;
          if (runs.every((r) => isPassingConclusion(r.conclusion))) {
            state.ciPassedSha = state.headSha;
          }
        }
      }
      // Commit the deferred check-runs cache only after successfully
      // consuming the response. See `fetchAllCheckRuns` for why we defer.
      if (stagedCheckRunsCache !== undefined) {
        state.checkRunsCache = stagedCheckRunsCache;
      }
      state.initialized = true;
      return;
    }

    // Diff and emit.
    if (commentsRes.status === 200) {
      state.etags.issueComments = commentsRes.etag;
      for (const c of commentsRes.data) {
        if (!state.seenIssueCommentIds.has(c.id)) {
          state.seenIssueCommentIds.add(c.id);
          this.emit(state, formatIssueComment(state.slug, pr.pullNumber, c));
        }
      }
      state.sinceCursors.issueComments =
        newestTimestamp(commentsRes.data) ?? state.sinceCursors.issueComments;
      this.trimSet(state.seenIssueCommentIds);
    }

    if (reviewCommentsRes.status === 200) {
      state.etags.reviewComments = reviewCommentsRes.etag;
      for (const c of reviewCommentsRes.data) {
        if (!state.seenReviewCommentIds.has(c.id)) {
          state.seenReviewCommentIds.add(c.id);
          this.emit(state, formatReviewComment(state.slug, pr.pullNumber, c));
        }
      }
      state.sinceCursors.reviewComments =
        newestTimestamp(reviewCommentsRes.data) ??
        state.sinceCursors.reviewComments;
      this.trimSet(state.seenReviewCommentIds);
    }

    if (reviewsRes.status === 200) {
      state.etags.reviews = reviewsRes.etag;
      for (const r of reviewsRes.data) {
        // Same reasoning as the seeding branch: ignore PENDING drafts —
        // they keep the same id when submitted, and emitting "reviewed"
        // on a draft would both be misleading and prevent the real
        // submission event from firing.
        if (r.state === 'PENDING') continue;
        if (!state.seenReviewIds.has(r.id)) {
          state.seenReviewIds.add(r.id);
          this.emit(state, formatReview(state.slug, pr.pullNumber, r));
        }
      }
      this.trimSet(state.seenReviewIds);
    }

    if (checksRes.status === 200) {
      // ETag/page caching is owned by `fetchAllCheckRuns` via
      // `state.checkRunsCache`; nothing to record on `state.etags` here.
      const runs = checksRes.data.check_runs;
      const newFailures: GhCheckRun[] = [];
      const currentFailureKeys = new Set<string>();
      for (const r of runs) {
        if (!this.isCheckFailure(r)) continue;
        const key = this.checkKey(r);
        currentFailureKeys.add(key);
        if (!state.lastFailedCheckKeys.has(key)) newFailures.push(r);
      }
      state.lastFailedCheckKeys = currentFailureKeys;
      if (newFailures.length >= COALESCE_THRESHOLD) {
        this.emit(
          state,
          formatCheckFailureSummary(state.slug, pr.pullNumber, newFailures),
        );
      } else {
        for (const r of newFailures) {
          this.emit(state, formatCheckFailure(state.slug, pr.pullNumber, r));
        }
      }

      // Emit two one-shot events per head SHA: "CI complete" on first
      // terminal state (any conclusion), then "CI passed" the first time
      // all checks pass (which may happen via a later rerun). Each is
      // deduped against its own marker so a rerun turning red→green still
      // emits "CI passed" even after "CI complete" already fired.
      //
      // Gate on `runs.length > 0`: an empty array is ambiguous (no CI
      // configured vs. runs not yet registered), so "done" isn't meaningful.
      // Also require we have the full set (length >= total_count). The API
      // caps at per_page=100; `fetchAllCheckRuns` walks pagination, dedupes
      // runs by id (so page-shift duplicates can't pad the count), AND
      // returns the latest `total_count` from this tick's 200 responses
      // (not a stale page-1 snapshot or a stuck monotonic max from a prior
      // mid-walk inflation). A duplicate-filled buffer can therefore never
      // trick this gate into firing "CI complete" before every run is seen.
      if (
        state.headSha &&
        runs.length > 0 &&
        runs.length >= checksRes.data.total_count &&
        runs.every((r) => r.status === 'completed')
      ) {
        const headSha = state.headSha;
        if (state.ciCompleteSha !== headSha) {
          state.ciCompleteSha = headSha;
          this.emit(
            state,
            formatCIComplete(state.slug, pr.pullNumber, headSha, runs),
          );
        }
        if (
          state.ciPassedSha !== headSha &&
          runs.every((r) => isPassingConclusion(r.conclusion))
        ) {
          state.ciPassedSha = headSha;
          this.emit(
            state,
            formatCIPassed(state.slug, pr.pullNumber, headSha, runs),
          );
        }
      }
    }

    // Commit the deferred check-runs cache only after successfully consuming
    // the response (including the diff branch above). See `fetchAllCheckRuns`
    // for why we defer: this prevents a sibling rejection in the `Promise.all`
    // from advancing the cache while the diff never ran, which would cause
    // the next tick to get 304 and silently skip the missed transitions.
    if (stagedCheckRunsCache !== undefined) {
      state.checkRunsCache = stagedCheckRunsCache;
    }
  }

  /**
   * Fetch all check-runs for a commit, walking pages when `total_count > 100`.
   *
   * The check-runs endpoint caps at `per_page=100`. PRs with more registered
   * runs (large monorepos, matrix builds) would otherwise have their terminal
   * gates (`runs.length >= total_count`) stuck false forever, stranding agents
   * waiting on "CI complete" / "CI passed".
   *
   * ## Mid-walk churn (additions, removals, dedupe)
   *
   * `total_count` and the per-page set of runs can both shift while we're
   * paginating: GitHub may register new runs (pushing earlier runs onto a
   * later page → duplicates across our pages), or runs may be removed/replaced
   * (a page shrinks). We defend against both:
   *
   * - We accumulate runs into a `Map<id, GhCheckRun>` so duplicates collapse.
   *   The terminal gate downstream (`runs.length >= total_count`) is evaluated
   *   against the deduped count, not the raw appended count, so a page-shift
   *   that fills our buffer with duplicates can't trick us into emitting
   *   "CI complete" before a newly-registered run has actually been seen.
   *
   * - We re-read `total_count` from every 200 response and use the LAST seen
   *   value (not the historical max). The server's `total_count` is its
   *   current authoritative count at the moment of that page-N fetch; if a
   *   transient mid-walk inflation later settles back down, taking the max
   *   would strand the gate forever (`runs.length` can never reach an
   *   inflated, no-longer-true total).
   *
   * The returned `total_count` is the latest observed server value (or, on
   * a full-304 tick, the previously-committed value carried via cache),
   * never page 1's stale snapshot.
   *
   * ## ETag caching (multi-page)
   *
   * Each page's ETag is cached on the subscription so subsequent ticks can
   * issue conditional `If-None-Match` requests per page. A 304 means we
   * reuse the previously-cached page contents; a 200 refreshes them.
   *
   * - Single-page (`total_count <= 100`): unchanged fast path — the page-1
   *   ETag covers the whole result and a 304 short-circuits the entire call.
   * - Multi-page: each page is independently conditional. In steady state
   *   (no new push, all runs settled) every page returns 304 and we make
   *   N HEAD-cheap requests instead of N full-page GETs, keeping the polling
   *   cost bounded on large matrix builds.
   *
   * ## Runaway guard
   *
   * `MAX_CHECK_RUNS_PAGES` caps the walk at 50 pages (5,000 runs). If a
   * misbehaving GitHub response or a runaway matrix would push us past it,
   * we log a warning and return what we have — better to under-report than
   * fan out into hundreds of GETs every 30s.
   */
  private async fetchAllCheckRuns(
    owner: string,
    repo: string,
    sha: string,
    state: SubscriptionState,
  ): Promise<{
    response: ConditionalResponse<{
      total_count: number;
      check_runs: GhCheckRun[];
    }>;
    /**
     * New per-page cache value to commit only after the caller has
     * successfully consumed the response. `undefined` means "no change" —
     * either the single-page 304 fast path (existing cache is still valid)
     * or this method itself short-circuited before fetching anything.
     *
     * Deferring the commit prevents a sibling rejection in `Promise.all`
     * from advancing the cache while the diff branch never runs: a stale
     * cache + 304 next tick would silently swallow check-run transitions.
     */
    stagedCache?: SubscriptionState['checkRunsCache'];
  }> {
    const basePath = `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}`;
    const cache = state.checkRunsCache;

    // Seed scratch caches we'll stage on the return value. We rebuild from
    // scratch each tick (rather than mutating in-place) so any pages dropped
    // on this tick — e.g. new push reduced page count from 5 to 3 — don't
    // leave stale entries behind.
    const nextEtags = new Map<number, string>();
    const nextPages = new Map<number, GhCheckRun[]>();

    // We need a place to record whether *every* page returned 304 so we can
    // surface a true 304 to the caller (and skip the seeding/diff work).
    let allPagesUnchanged = true;
    // `latestTotal` tracks the most recent 200 response's `total_count`.
    // Crucially we do NOT carry `cache.lastTotalCount` into this — that
    // would let a transient prior-tick inflation persist forever once page-1
    // starts returning 304 against the unchanged content (the cached
    // `lastTotalCount` would seed the gate every tick and `runs.length`
    // could never catch up to an inflated, no-longer-true total).
    let latestTotal: number | undefined;

    const fetchPage = async (
      page: number,
    ): Promise<{
      runs: GhCheckRun[];
      total: number | undefined;
      was304: boolean;
    }> => {
      const pageEtag = cache?.etagsByPage.get(page);
      const res = await ghGet<{
        total_count: number;
        check_runs: GhCheckRun[];
      }>(`${basePath}&page=${page}`, pageEtag);
      if (res.status === 304) {
        // Reuse cached page. Carry forward the ETag we sent.
        const cachedRuns = cache?.pagesByPage.get(page) ?? [];
        if (pageEtag) nextEtags.set(page, pageEtag);
        nextPages.set(page, cachedRuns);
        return {
          runs: cachedRuns,
          // total_count isn't returned on 304. We deliberately return
          // undefined here rather than falling back to `cache.lastTotalCount`,
          // because that cached value may itself be stale (an inflated value
          // committed during a prior mid-walk race). The terminal `latestTotal`
          // is derived from this tick's 200 responses; only when *every* page
          // is 304 do we reuse the cached total below — and that case
          // genuinely means "nothing changed since we last committed".
          total: undefined,
          was304: true,
        };
      }
      if (res.etag) nextEtags.set(page, res.etag);
      nextPages.set(page, res.data.check_runs);
      return {
        runs: res.data.check_runs,
        total: res.data.total_count,
        was304: false,
      };
    };

    // Page 1 always runs — we need its `total_count` (or a 304 fast-path
    // when nothing changed).
    const first = await fetchPage(1);
    if (!first.was304) allPagesUnchanged = false;
    if (first.total !== undefined) latestTotal = first.total;

    // Single-page fast path. If page 1 was 304 and our last-known total fits
    // in one page, we can short-circuit the whole call without touching any
    // other state — this is the common steady-state for typical PRs. No
    // staged cache: the existing `state.checkRunsCache` is still valid and
    // we never built a replacement.
    if (
      first.was304 &&
      cache &&
      cache.lastTotalCount <= CHECK_RUNS_PAGE_SIZE &&
      cache.etagsByPage.size === 1
    ) {
      return { response: { status: 304 } };
    }

    // Dedupe by run id. Pagination is not transactional on GitHub: when a
    // new run is registered mid-walk, runs can shift across page boundaries
    // and we'd otherwise see the same id on two different pages (or miss
    // one entirely). A `Map<id, run>` collapses duplicates and lets the
    // downstream `runs.length >= total_count` gate evaluate against the
    // true unique count.
    const runsById = new Map<number, GhCheckRun>();
    for (const r of first.runs) runsById.set(r.id, r);

    // How many pages to walk this tick. We need a starting estimate before
    // we've seen any 200 with a non-cached total, so we fall back to the
    // cached `lastTotalCount` when page-1 was 304 (unchanged content → the
    // server's view almost certainly matches what we last committed). If a
    // 200 arrives later, `latestTotal` takes precedence and we recompute.
    const seedTotal = latestTotal ?? cache?.lastTotalCount ?? 0;
    let totalPages = Math.max(1, Math.ceil(seedTotal / CHECK_RUNS_PAGE_SIZE));
    if (totalPages > MAX_CHECK_RUNS_PAGES) {
      this.logger.warn(
        `Pagination cap hit for ${owner}/${repo}@${sha.slice(0, 7)} check-runs: ` +
          `total_count=${seedTotal} would need ${totalPages} pages, capping at ${MAX_CHECK_RUNS_PAGES}.`,
      );
      totalPages = MAX_CHECK_RUNS_PAGES;
    }
    if (totalPages > 1) {
      this.logger.info(
        `Pagination: ${owner}/${repo}@${sha.slice(0, 7)} check-runs total_count=${seedTotal} → ${totalPages} pages`,
      );
    }

    let page = 2;
    while (page <= totalPages) {
      const result = await fetchPage(page);
      if (!result.was304) allPagesUnchanged = false;
      for (const r of result.runs) runsById.set(r.id, r);

      // Use the LATEST observed `total_count` (from this page's 200) as the
      // authoritative server view. Walk-length adapts to it whether it grew
      // OR shrank: a transient inflation that has since settled back down
      // must be allowed to take effect, otherwise a max-style monotonic
      // tracker would strand the terminal gate forever.
      if (result.total !== undefined) {
        latestTotal = result.total;
        const newTotalPages = Math.max(
          1,
          Math.ceil(latestTotal / CHECK_RUNS_PAGE_SIZE),
        );
        if (newTotalPages > MAX_CHECK_RUNS_PAGES) {
          this.logger.warn(
            `Pagination cap hit mid-walk for ${owner}/${repo}@${sha.slice(0, 7)} check-runs: ` +
              `total_count is ${latestTotal} (${newTotalPages} pages), capping at ${MAX_CHECK_RUNS_PAGES}.`,
          );
          totalPages = MAX_CHECK_RUNS_PAGES;
        } else {
          totalPages = newTotalPages;
        }
      }
      page += 1;
    }

    // Resolve the total we'll surface and cache. Priority order:
    //  1. The last 200's `total_count` (current server-authoritative value).
    //  2. If every page was 304, the previously-committed `lastTotalCount`
    //     — nothing actually changed, so the prior commit is still correct.
    //  3. Fall back to the deduped run count (degenerate case, no 200s and
    //     no cache; e.g. brand-new subscription with empty results).
    const reportedTotal = latestTotal ?? cache?.lastTotalCount ?? runsById.size;

    // Stage the per-page caches. The caller commits to `state.checkRunsCache`
    // only after successfully consuming the response — see the type doc above.
    // We always overwrite on commit: any pages from a previous tick that we
    // didn't touch this tick (e.g. page count shrank) are intentionally evicted.
    const stagedCache = {
      etagsByPage: nextEtags,
      pagesByPage: nextPages,
      lastTotalCount: reportedTotal,
    };

    // True end-to-end 304: every page came back unchanged. Caller can skip
    // the diff/seed work entirely.
    if (allPagesUnchanged) {
      return { response: { status: 304 }, stagedCache };
    }

    return {
      response: {
        status: 200,
        data: {
          total_count: reportedTotal,
          check_runs: [...runsById.values()],
        },
        // No single ETag covers a multi-page response. The per-page cache on
        // `state.checkRunsCache` is what enables conditional reuse next tick.
        etag: undefined,
      },
      stagedCache,
    };
  }

  private isCheckFailure(r: GhCheckRun): boolean {
    if (r.status !== 'completed') return false;
    const c = r.conclusion;
    return c === 'failure' || c === 'timed_out' || c === 'cancelled';
  }

  private checkKey(r: GhCheckRun): string {
    return `${r.id}:${r.completed_at ?? ''}`;
  }

  /** Stop polling and forget every subscription. For extension teardown. */
  disposeAll(): void {
    this.subscriptions.clear();
    this.stopTimer();
    this.notifyKeysChanged();
  }
}

/** Process-wide singleton. */
export const prPollingSource = new PRPollingSource();
