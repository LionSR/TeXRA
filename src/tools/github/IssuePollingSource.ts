/**
 * Poll-based event source for a single GitHub issue.
 *
 * Per tick: 2 GETs.
 *
 *   GET /repos/{o}/{r}/issues/{n}                       (state transitions)
 *   GET /repos/{o}/{r}/issues/{n}/comments?since=…      (new comments)
 *
 * Emits: comment added, issue closed (with `state_reason`), issue reopened.
 * Auto-unsubscribes on close, mirroring `PRPollingSource`.
 *
 * Issues are simpler than PRs: no review threads, no check runs, no merge
 * state. The base class handles lifecycle and error classification; this
 * file only owns the per-issue endpoint set and the dedup state.
 */

import { shouldDropBotEvent } from './botFilter';
import {
  formatIssueClosed,
  formatIssueComment,
  formatIssueReopened,
  formatIssueSubscriptionError,
} from './formatIssueEvent';
import { getNewestTimestamp, trimSet } from './formatUtils';
import { ghGet } from './githubClient';
import {
  PollingSourceBase,
  type BasePollSubscriptionState,
} from './PollingSourceBase';
import { emitGitHubSubscriptionChanged } from './subscriptionEventEmitter';
import type { GhIssue, GhIssueComment } from './prTypes';

import type { Disposable } from '@platform/interfaces/disposable';

const MAX_SEEN_IDS = 1000;

export interface IssueKey {
  owner: string;
  repo: string;
  issueNumber: number;
}

export function issueKeyToString(k: IssueKey): string {
  return `${k.owner}/${k.repo}/issues/${k.issueNumber}`;
}

interface SubscriptionState extends BasePollSubscriptionState {
  issue: IssueKey;
  /** `owner/repo` — used in event-message slug interpolation. */
  slug: string;
  initialized: boolean;
  state: 'open' | 'closed' | undefined;
  seenCommentIds: Set<number>;
  etags: { issue?: string; comments?: string };
  sinceCursor?: string;
}

function createInitialState(issue: IssueKey): SubscriptionState {
  return {
    issue,
    slug: `${issue.owner}/${issue.repo}`,
    listeners: new Set(),
    initialized: false,
    state: undefined,
    seenCommentIds: new Set(),
    etags: {},
    sinceCursor: undefined,
    lastSuccessAt: Date.now(),
    consecutiveFailures: 0,
    skipPollUntilMs: 0,
  };
}

function withSince(url: string, since: string | undefined): string {
  if (!since) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}since=${encodeURIComponent(since)}`;
}

export class IssuePollingSource extends PollingSourceBase<
  string,
  SubscriptionState
> {
  constructor() {
    super({
      name: 'IssuePollingSource',
      pollIntervalMs: 30_000,
      maxConcurrent: 10,
      backoffBaseMs: 60_000,
      backoffMaxMs: 3_600_000,
      maxFailureDurationMs: 24 * 3_600_000,
    });
  }

  subscribe(issue: IssueKey, onEvent: (text: string) => void): Disposable {
    const key = issueKeyToString(issue);
    return this.register(key, () => createInitialState(issue), onEvent);
  }

  protected emitKeysChangedEvent(keys: readonly string[]): void {
    emitGitHubSubscriptionChanged('issueSubscriptionsChanged', { keys });
  }

  protected formatErrorEvent(
    _key: string,
    state: SubscriptionState,
    detail: string,
  ): string {
    return formatIssueSubscriptionError(
      state.slug,
      state.issue.issueNumber,
      detail,
    );
  }

  protected async pollOne(
    _key: string,
    state: SubscriptionState,
  ): Promise<void> {
    const { issue } = state;
    const issuePath = `/repos/${issue.owner}/${issue.repo}/issues/${issue.issueNumber}`;
    const commentsUrl = withSince(
      `${issuePath}/comments?per_page=100`,
      state.sinceCursor,
    );

    // The two endpoints are independent — fetch in parallel.
    const [issueRes, commentsRes] = await Promise.all([
      ghGet<GhIssue>(issuePath, state.etags.issue),
      ghGet<GhIssueComment[]>(commentsUrl, state.etags.comments),
    ]);

    if (issueRes.status === 200) {
      state.etags.issue = issueRes.etag;
      const newState = issueRes.data.state;
      // Issues, unlike PRs, can reopen after close — and that's a genuine
      // signal a subscriber wants. So we keep polling on close: emit the
      // close event but stay subscribed so a later reopen surfaces too.
      // Slot release is via explicit unsubscribe or the 24 h unreachable
      // failsafe. Bound by `maxConcurrent` (10).
      if (
        state.initialized &&
        state.state === 'open' &&
        newState === 'closed'
      ) {
        this.emit(
          state,
          formatIssueClosed(state.slug, issue.issueNumber, issueRes.data),
        );
      }
      if (
        state.initialized &&
        state.state === 'closed' &&
        newState === 'open'
      ) {
        this.emit(
          state,
          formatIssueReopened(state.slug, issue.issueNumber, issueRes.data),
        );
      }
      state.state = newState;
    }

    if (!state.initialized) {
      if (commentsRes.status === 200) {
        state.etags.comments = commentsRes.etag;
        for (const c of commentsRes.data) state.seenCommentIds.add(c.id);
        state.sinceCursor = getNewestTimestamp(commentsRes.data);
      }
      state.initialized = true;
      return;
    }

    if (commentsRes.status === 200) {
      state.etags.comments = commentsRes.etag;
      for (const c of commentsRes.data) {
        if (state.seenCommentIds.has(c.id)) continue;
        state.seenCommentIds.add(c.id);
        if (shouldDropBotEvent(c.user)) continue;
        this.emit(state, formatIssueComment(state.slug, issue.issueNumber, c));
      }
      state.sinceCursor =
        getNewestTimestamp(commentsRes.data) ?? state.sinceCursor;
      trimSet(state.seenCommentIds, MAX_SEEN_IDS);
    }
  }
}

export const issuePollingSource = new IssuePollingSource();
