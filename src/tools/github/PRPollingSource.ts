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
  formatIssueComment,
  formatPRClosed,
  formatReview,
  formatReviewComment,
  formatSubscriptionError,
} from './formatPREvent';
import {
  GitHubAuthError,
  GitHubRateLimitError,
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
  items: ReadonlyArray<{ created_at?: string | null; updated_at?: string | null }>,
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
  headSha: string | undefined;
  state: 'open' | 'closed' | undefined;
  merged: boolean;
  // ETags for conditional requests.
  etags: {
    pr?: string;
    issueComments?: string;
    reviewComments?: string;
    reviews?: string;
    checkRuns?: string;
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
  private readonly changeListeners = new Set<(keys: readonly string[]) => void>();
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
                formatSubscriptionError(state.slug, state.pr.pullNumber, err.message),
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
        this.logger.warn(`Listener threw for ${prKeyToString(state.pr)}: ${String(err)}`);
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
      if (state.initialized && state.state === 'open' && newState === 'closed') {
        this.emit(
          state,
          formatPRClosed(state.slug, pr.pullNumber, newMerged),
        );
        // Auto-unsubscribe.
        this.subscriptions.delete(prKeyToString(pr));
        this.notifyKeysChanged();
        return;
      }
      state.state = newState;
      state.merged = newMerged;
      state.headSha = newHead;
    }

    // Bail cleanly if the PR is already closed. On the first (initialization)
    // tick this prevents a zombie subscription: without this branch the
    // subscription would stay in the map forever, burning an API call every
    // 30s and a slot in the concurrent-subscription cap, because the
    // open→closed auto-unsubscribe transition above never fires for a PR
    // that was closed before we started watching.
    if (state.state === 'closed') {
      if (!state.initialized) {
        this.emit(
          state,
          formatPRClosed(state.slug, pr.pullNumber, state.merged),
        );
        this.subscriptions.delete(prKeyToString(pr));
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
    const [commentsRes, reviewCommentsRes, reviewsRes, checksRes] =
      await Promise.all([
        ghGet<GhIssueComment[]>(
          issueCommentsUrl,
          state.etags.issueComments,
        ),
        ghGet<GhReviewComment[]>(
          reviewCommentsUrl,
          state.etags.reviewComments,
        ),
        ghGet<GhReview[]>(
          `${prPath}/reviews?per_page=100`,
          state.etags.reviews,
        ),
        state.headSha
          ? ghGet<{ check_runs: GhCheckRun[] }>(
              `/repos/${pr.owner}/${pr.repo}/commits/${state.headSha}/check-runs?per_page=100`,
              state.etags.checkRuns,
            )
          : Promise.resolve({ status: 304 as const }),
      ]);

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
        for (const r of reviewsRes.data) state.seenReviewIds.add(r.id);
      }
      if (checksRes.status === 200) {
        state.etags.checkRuns = checksRes.etag;
        for (const r of checksRes.data.check_runs) {
          if (this.isCheckFailure(r)) {
            state.lastFailedCheckKeys.add(this.checkKey(r));
          }
        }
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
        if (!state.seenReviewIds.has(r.id)) {
          state.seenReviewIds.add(r.id);
          this.emit(state, formatReview(state.slug, pr.pullNumber, r));
        }
      }
      this.trimSet(state.seenReviewIds);
    }

    if (checksRes.status === 200) {
      state.etags.checkRuns = checksRes.etag;
      const newFailures: GhCheckRun[] = [];
      const currentFailureKeys = new Set<string>();
      for (const r of checksRes.data.check_runs) {
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
    }
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
