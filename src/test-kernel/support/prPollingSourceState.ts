// Local imports - tools
import {
  createBasePollState,
  DedupedResource,
  MAX_SEEN_IDS,
} from '@tools/github/PollingSourceBase';
import type {
  PRCurrentShaState,
  PRSubscriptionState,
} from '@tools/github/PRPollingSource';
import type {
  GhIssueComment,
  GhReview,
  GhReviewComment,
} from '@tools/github/prTypes';

/**
 * Builders for the real `PRPollingSource` subscription state. Suites drive the
 * source's protected `pollOne` / `drainAnnotationQueues` with a hand-built
 * state, so building it through the production types is what makes a new
 * state field a compile error here instead of a silently-stale test double.
 */

export function createPRCurrentShaState(
  sha: string,
  overrides: Partial<Omit<PRCurrentShaState, 'sha'>> = {},
): PRCurrentShaState {
  return {
    sha,
    ciStarted: false,
    ciComplete: false,
    ciPassed: false,
    checkRunsCache: undefined,
    pendingAnnotationRuns: [],
    ...overrides,
  };
}

export function createPRSubscriptionState(
  overrides: Partial<PRSubscriptionState> = {},
): PRSubscriptionState {
  return {
    pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
    slug: 'owner/repo',
    ...createBasePollState(),
    initialized: true,
    issueComments: new DedupedResource<GhIssueComment>({
      getId: (comment) => comment.id,
      maxSeenIds: MAX_SEEN_IDS,
    }),
    reviewComments: new DedupedResource<GhReviewComment>({
      getId: (comment) => comment.id,
      maxSeenIds: MAX_SEEN_IDS,
    }),
    reviews: new DedupedResource<GhReview>({
      getId: (review) => review.id,
      maxSeenIds: MAX_SEEN_IDS,
    }),
    lastFailedCheckKeys: new Set(),
    lastAnnotationKeys: new Set(),
    annotationLevelByListener: new Map(),
    currentShaState: undefined,
    state: undefined,
    merged: false,
    mergeableState: undefined,
    etags: {},
    ...overrides,
  };
}
