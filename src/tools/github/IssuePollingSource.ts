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

import { appSignals } from '@eventBus/AppSignals';
import type { Disposable } from '@platform/interfaces';
import { shouldDropBotEvent } from './botFilter';
import {
  formatIssueClosed,
  formatIssueComment,
  formatIssueReopened,
  formatIssueSubscriptionError,
} from './formatIssueEvent';
import { issueRef, withSince } from './formatUtils';
import { ghGet } from './githubClient';
import {
  type BasePollSubscriptionState,
  createBasePollState,
  DEFAULT_POLLING_BACKOFF_CONFIG,
  dedupeComments,
  type DedupedResource,
  PollingSourceBase,
} from './PollingSourceBase';
import {
  MAX_CONCURRENT_ISSUE_SUBSCRIPTIONS,
  PR_POLL_INTERVAL_MS,
} from './prSubscriptionConstants';
import {
  GhIssueCommentArraySchema,
  GhIssueSchema,
  type GhIssue,
  type GhIssueComment,
} from './prTypes';

export interface IssueKey {
  owner: string;
  repo: string;
  issueNumber: number;
}

export function issueKeyToString(k: IssueKey): string {
  return issueRef(`${k.owner}/${k.repo}`, k.issueNumber);
}

interface SubscriptionState extends BasePollSubscriptionState {
  issue: IssueKey;
  /** `owner/repo` — used in event-message slug interpolation. */
  slug: string;
  initialized: boolean;
  state: 'open' | 'closed' | undefined;
  comments: DedupedResource<GhIssueComment>;
  etags: { issue?: string; comments?: string };
}

function createInitialState(issue: IssueKey): SubscriptionState {
  return {
    issue,
    slug: `${issue.owner}/${issue.repo}`,
    ...createBasePollState(),
    initialized: false,
    state: undefined,
    comments: dedupeComments<GhIssueComment>(),
    etags: {},
  };
}

class IssuePollingSource extends PollingSourceBase<string, SubscriptionState> {
  constructor() {
    super({
      name: 'IssuePollingSource',
      pollIntervalMs: PR_POLL_INTERVAL_MS,
      maxConcurrent: MAX_CONCURRENT_ISSUE_SUBSCRIPTIONS,
      ...DEFAULT_POLLING_BACKOFF_CONFIG,
    });
  }

  subscribe(issue: IssueKey, onEvent: (text: string) => void): Disposable {
    const key = issueKeyToString(issue);
    return this.register(key, () => createInitialState(issue), onEvent);
  }

  protected emitKeysChangedEvent(keys: readonly string[]): void {
    appSignals.emit('issueSubscriptionsChanged', { keys });
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
      state.comments.sinceCursor,
    );

    // The two endpoints are independent — fetch in parallel.
    const [issueRes, commentsRes] = await Promise.all([
      ghGet<GhIssue>(issuePath, state.etags.issue),
      ghGet<GhIssueComment[]>(commentsUrl, state.etags.comments),
    ]);

    if (issueRes.status === 200) {
      // Validate the issue payload non-throwingly. On failure, skip ONLY the
      // issue-state check (don't advance state.etags.issue) and fall through to
      // the independent comments fetch below — a malformed issue payload must
      // not block comment delivery. Never throw: a throw would stall
      // lastSuccessAt and risk the 24 h detach of a live subscription.
      const parsedIssue = this.validateOrSkip(
        issueRes,
        GhIssueSchema,
        `Skipping issue-state check for ${state.slug}#${issue.issueNumber}: malformed issue payload`,
      );
      if (parsedIssue) {
        const issueData = parsedIssue.data;
        state.etags.issue = issueRes.etag;
        const newState = issueData.state;
        // Issues, unlike PRs, can reopen after close — and that's a genuine
        // signal a subscriber wants. So we keep polling on close: emit the
        // close event but stay subscribed so a later reopen surfaces too.
        // Slot release is via explicit unsubscribe or the 24 h unreachable
        // failsafe. Bound by `maxConcurrent`.
        if (state.initialized && state.state !== newState) {
          if (state.state === 'open' && newState === 'closed') {
            this.emit(
              state,
              formatIssueClosed(state.slug, issue.issueNumber, issueData),
            );
          } else if (state.state === 'closed') {
            this.emit(
              state,
              formatIssueReopened(state.slug, issue.issueNumber, issueData),
            );
          }
        }
        state.state = newState;
      }
    }

    // Validate the comments array non-throwingly: on a malformed payload, log
    // + skip this tick. state.etags.comments and the comments cursor are
    // advanced only after a successful parse, so a skip re-fetches next tick
    // (no If-None-Match) and lastSuccessAt still advances → no 24 h detach. A
    // bad single element triggers a whole-array skip instead of a mid-loop
    // TypeError throw. The first tick only seeds so we never replay history.
    if (commentsRes.status === 200) {
      const parsedComments = this.validateOrSkip(
        commentsRes,
        GhIssueCommentArraySchema,
        `Skipping comments tick for ${state.slug}#${issue.issueNumber}: malformed comments payload`,
      );
      if (!parsedComments) return;
      state.etags.comments = commentsRes.etag;
      if (state.initialized) {
        state.comments.diff(parsedComments.data, (c) => {
          if (shouldDropBotEvent(c.user)) return;
          this.emit(
            state,
            formatIssueComment(state.slug, issue.issueNumber, c),
          );
        });
      } else {
        state.comments.seed(parsedComments.data);
      }
    }

    state.initialized = true;
  }
}

export const SharedIssuePollingSource = new IssuePollingSource();
