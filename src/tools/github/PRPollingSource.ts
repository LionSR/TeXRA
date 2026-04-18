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

import { AgentLogger } from '@logger/AgentLogger';

import {
  formatCheckFailure,
  formatCheckFailureSummary,
  formatIssueComment,
  formatPRClosed,
  formatReview,
  formatReviewComment,
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
  consecutiveFailures: number;
}

export class PRPollingSource implements AsyncEventSource {
  private readonly logger = new AgentLogger('PRPollingSource');
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private timer: ReturnType<typeof setInterval> | undefined;

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
        consecutiveFailures: 0,
      };
      this.subscriptions.set(key, state);
      this.logger.info(`Subscribed to ${key}`);
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

  private async tick(): Promise<void> {
    for (const [key, state] of this.subscriptions) {
      try {
        await this.pollOne(state);
        state.consecutiveFailures = 0;
      } catch (err) {
        state.consecutiveFailures += 1;
        if (err instanceof GitHubAuthError) {
          this.logger.warn(
            `Auth error for ${key}; stopping subscription. ${err.message}`,
          );
          this.emit(state, err.message);
          this.subscriptions.delete(key);
        } else if (err instanceof GitHubRateLimitError) {
          this.logger.warn(`Rate limited while polling ${key}: ${err.message}`);
        } else {
          this.logger.warn(
            `Poll failed for ${key} (${state.consecutiveFailures} in a row): ${String(err)}`,
          );
          if (state.consecutiveFailures >= 5) {
            this.emit(
              state,
              `PR subscription to ${key} halted after repeated failures: ${String(err)}`,
            );
            this.subscriptions.delete(key);
          }
        }
      }
    }
    if (this.subscriptions.size === 0) this.stopTimer();
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
        return;
      }
      state.state = newState;
      state.merged = newMerged;
      state.headSha = newHead;
    }

    // If the PR is closed and we have no prior state, skip the rest.
    if (state.state === 'closed') {
      state.initialized = true;
      return;
    }

    const [commentsRes, reviewCommentsRes, reviewsRes, checksRes] =
      await Promise.all([
        ghGet<GhIssueComment[]>(
          `${issuePath}/comments?per_page=100`,
          state.etags.issueComments,
        ),
        ghGet<GhReviewComment[]>(
          `${prPath}/comments?per_page=100`,
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
      }
      if (reviewCommentsRes.status === 200) {
        state.etags.reviewComments = reviewCommentsRes.etag;
        for (const c of reviewCommentsRes.data)
          state.seenReviewCommentIds.add(c.id);
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
    }

    if (reviewCommentsRes.status === 200) {
      state.etags.reviewComments = reviewCommentsRes.etag;
      for (const c of reviewCommentsRes.data) {
        if (!state.seenReviewCommentIds.has(c.id)) {
          state.seenReviewCommentIds.add(c.id);
          this.emit(state, formatReviewComment(state.slug, pr.pullNumber, c));
        }
      }
    }

    if (reviewsRes.status === 200) {
      state.etags.reviews = reviewsRes.etag;
      for (const r of reviewsRes.data) {
        if (!state.seenReviewIds.has(r.id)) {
          state.seenReviewIds.add(r.id);
          this.emit(state, formatReview(state.slug, pr.pullNumber, r));
        }
      }
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
  }
}

/** Process-wide singleton. */
export const prPollingSource = new PRPollingSource();
