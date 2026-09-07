/**
 * Poll-based event source for GitHub PR activity.
 *
 * Each subscribed PR maintains per-resource cursors (last-seen ID) and ETags.
 * A single shared timer ticks every `GITHUB_POLL_INTERVAL_MS` and iterates all
 * active subscriptions. Events are converted to natural-language text via
 * `formatPREvent` and dispatched to per-caller listeners.
 *
 * Transport is polling for v1; swapping to a push transport (e.g. a Supabase
 * edge function fan-out) would replace this file without affecting the tool
 * layer above.
 */

import { Clock, Effect } from 'effect';

import type { Disposable } from '@platform/interfaces';
import { shouldDropBotEvent } from './botFilter';
import {
  DEFAULT_CHECK_ANNOTATION_LEVEL,
  includesCheckAnnotationLevel,
  type GitHubCheckAnnotationLevel,
} from './checkAnnotationLevels';
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
  formatPRIssueComment,
  formatReview,
  formatReviewComment,
  formatSubscriptionError,
} from './formatPREvent';
import { prRef, withSince } from './githubPaths';
import {
  ghGet,
  type ConditionalResponse,
  GitHubAuthError,
  GitHubPermanentError,
  GitHubRateLimitError,
} from './githubClient';
import {
  SharedAnnotationFetchBudget,
  AnnotationFetchBudgetExhaustedError,
} from './annotationFetchBudget';
import {
  fetchAllCheckRuns as fetchAllCheckRunsClient,
  fetchAnnotations as fetchAnnotationsClient,
  type CheckRunsCache,
} from './checkRunsClient';
import {
  checkKey,
  ciTerminalStatus,
  computeNewCheckFailures,
  isCheckFailure,
  planAnnotationCandidates,
} from './prCheckRunDomain';
import {
  type BasePollSubscriptionState,
  createBasePollState,
  DEFAULT_POLLING_BACKOFF_CONFIG,
  dedupeComments,
  DedupedResource,
  MAX_SEEN_IDS,
  type PollEventListener,
  type PollHookRejected,
  PollingSourceBase,
  pollRequest,
} from './PollingSourceBase';
import {
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  GITHUB_POLL_INTERVAL_MS,
} from './prSubscriptionConstants';
import {
  isDefiniteMergeableState,
  GhPullRequestSchema,
  type GhCheckAnnotation,
  type GhCheckRun,
  type GhIssueComment,
  type GhPullRequest,
  type GhReview,
  type GhReviewComment,
} from './prTypes';

function createInitialState(pr: PRKey): PRSubscriptionState {
  return {
    pr,
    slug: `${pr.owner}/${pr.repo}`,
    ...createBasePollState(),
    initialized: false,
    issueComments: dedupeComments<GhIssueComment>(),
    reviewComments: dedupeComments<GhReviewComment>(),
    reviews: new DedupedResource<GhReview>({
      getId: (review: GhReview) => review.id,
      maxSeenIds: MAX_SEEN_IDS,
    }),
    lastFailedCheckKeys: new Set(),
    lastAnnotationKeys: new Set(),
    annotationLevelByListener: new Map(),
    currentShaState: undefined,
    mergeableState: undefined,
    etags: {},
  };
}

// Coalesce this many same-kind events in a single tick into a summary.
const COALESCE_THRESHOLD = 3;
// Bound the per-subscription fan-out across runs (e.g. a matrix build
// lighting up a fleet of checks). Excess candidates stay in
// `pendingAnnotationRuns` and are drained on subsequent ticks.
const MAX_ANNOTATION_RUNS_PER_SUBSCRIPTION_TICK = 3;

function isSubmittedReview(review: GhReview): boolean {
  return review.state !== 'PENDING';
}

interface PRKey {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface PRSubscribeInput extends PRKey {
  minAnnotationLevel?: GitHubCheckAnnotationLevel;
}

export function prKeyToString(k: PRKey): string {
  return prRef(`${k.owner}/${k.repo}`, k.pullNumber);
}

export interface PRSubscriptionState extends BasePollSubscriptionState {
  pr: PRKey;
  slug: string;
  /** Initialized on first tick so we don't replay historical events. */
  initialized: boolean;
  issueComments: DedupedResource<GhIssueComment>;
  reviewComments: DedupedResource<GhReviewComment>;
  reviews: DedupedResource<GhReview>;
  lastFailedCheckKeys: Set<string>;
  /**
   * `${id}:${completed_at}` for runs observed (with annotations) on the most
   * recent 200 tick. Replaced wholesale every 200 tick (mirrors
   * `lastFailedCheckKeys`) so it can't grow unboundedly and FIFO eviction
   * can't mistake a still-present run for a new one.
   */
  lastAnnotationKeys: Set<string>;
  annotationLevelByListener: Map<PollEventListener, GitHubCheckAnnotationLevel>;
  /**
   * Everything scoped to the current head SHA: the SHA itself, the CI one-shot
   * markers, the check-runs page cache, and the pending annotation-fetch
   * queue. Replaced wholesale whenever the head SHA changes (see the reset in
   * `pollOne`), so a future per-SHA field added here can't leak stale state
   * across a push — there's no separate list of fields to remember to clear.
   */
  currentShaState: PRCurrentShaState | undefined;
  /** Last *definite* `mergeable_state`; see `isDefiniteMergeableState`. */
  mergeableState: string | undefined;
  etags: {
    pr?: string;
    issueComments?: string;
    reviewComments?: string;
    reviews?: string;
  };
}

/** Per-head-SHA state; reset wholesale whenever the head SHA changes. */
export interface PRCurrentShaState {
  sha: string;
  /** Whether the one-shot "CI triggered" event has been emitted for `sha`. */
  ciStarted: boolean;
  /** Whether the one-shot "CI complete" event has been emitted for `sha`. */
  ciComplete: boolean;
  /** Whether the one-shot "CI passed" event has been emitted for `sha`. */
  ciPassed: boolean;
  /**
   * Per-page cache for the paginated check-runs endpoint. Single-page PRs
   * touch only page 1 so still get the cheap 304 fast path; multi-page PRs
   * issue conditional GETs per page so steady-state ticks make N HEAD-cheap
   * 304s instead of N full-page GETs.
   *
   * `lastTotalCount` is the most recent `total_count` from a 200 response;
   * it tells us how many pages to walk when page 1 returns 304.
   */
  checkRunsCache?: CheckRunsCache;
  /**
   * Annotated runs awaiting an annotations-endpoint fetch. Populated by the
   * 200 branch (newly-seen keys), drained on every tick (200 OR 304) so a
   * burst that overflows the per-subscription or process-wide fetch budget
   * isn't stranded once the check-runs cache stabilizes.
   */
  pendingAnnotationRuns: GhCheckRun[];
}

export class PRPollingSource extends PollingSourceBase<
  string,
  PRSubscriptionState
> {
  private nextAnnotationDrainKey: string | undefined;

  constructor() {
    super({
      name: 'PRPollingSource',
      pollIntervalMs: GITHUB_POLL_INTERVAL_MS,
      maxConcurrent: MAX_CONCURRENT_PR_SUBSCRIPTIONS,
      ...DEFAULT_POLLING_BACKOFF_CONFIG,
    });
  }

  /** Reset the process-wide annotation budget between unit tests. */
  static resetAnnotationFetchBudgetForTests(
    remainingFetches?: number,
    nowMs?: number,
  ): void {
    SharedAnnotationFetchBudget.resetForTests(remainingFetches, nowMs);
  }

  subscribe(
    input: PRSubscribeInput,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable> {
    const key = prKeyToString(input);
    return this.register(key, () => createInitialState(input), onEvent).pipe(
      Effect.map((disposable) => {
        this.setListenerAnnotationLevel(key, onEvent, input);
        return {
          dispose: () => {
            this.getSubscriptionState(key)?.annotationLevelByListener.delete(
              onEvent,
            );
            disposable.dispose();
          },
        };
      }),
    );
  }

  updateSubscription(
    input: PRSubscribeInput,
    onEvent: PollEventListener,
  ): void {
    const key = prKeyToString(input);
    this.setListenerAnnotationLevel(key, onEvent, input);
  }

  /** Resolve the effective annotation level and record it per listener. */
  private setListenerAnnotationLevel(
    key: string,
    onEvent: PollEventListener,
    input: PRSubscribeInput,
  ): void {
    const minAnnotationLevel =
      input.minAnnotationLevel ?? DEFAULT_CHECK_ANNOTATION_LEVEL;
    this.getSubscriptionState(key)?.annotationLevelByListener.set(
      onEvent,
      minAnnotationLevel,
    );
  }

  protected formatErrorEvent(
    state: PRSubscriptionState,
    detail: string,
  ): string {
    return formatSubscriptionError(state.slug, state.pr.pullNumber, detail);
  }

  protected override afterTick(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
    now: number,
  ): Effect.Effect<void, PollHookRejected> {
    return this.drainAnnotationQueues(entries, now);
  }

  protected pollOne(
    key: string,
    state: PRSubscriptionState,
  ): Effect.Effect<void, PollHookRejected> {
    return this.pollPr(key, state);
  }

  private readonly pollPr = Effect.fn('PRPollingSource.pollPr')(function* (
    this: PRPollingSource,
    key: string,
    state: PRSubscriptionState,
  ) {
    const { pr } = state;
    const prPath = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pullNumber}`;
    const issuePath = `/repos/${pr.owner}/${pr.repo}/issues/${pr.pullNumber}`;

    if (!(yield* this.refreshPrMetadata(key, state, prPath))) return;

    // `stagedCheckRunsCache` stays uncommitted here on purpose: it is written
    // to `currentShaState.checkRunsCache` only at the end of the success path
    // (after the diff branch), so a sibling rejection in the parallel fetch
    // can never advance the cache while the diff never ran — a stale cache +
    // 304 next tick would silently swallow check-run transitions.
    const issueCommentsUrl = withSince(
      `${issuePath}/comments?per_page=100`,
      state.issueComments.sinceCursor,
    );
    const reviewCommentsUrl = withSince(
      `${prPath}/comments?per_page=100`,
      state.reviewComments.sinceCursor,
    );
    const [
      commentsRes,
      reviewCommentsRes,
      reviewsRes,
      { response: checksRes, stagedCache: stagedCheckRunsCache },
    ] = yield* Effect.all(
      [
        pollRequest(() =>
          ghGet<GhIssueComment[]>(issueCommentsUrl, state.etags.issueComments),
        ),
        pollRequest(() =>
          ghGet<GhReviewComment[]>(
            reviewCommentsUrl,
            state.etags.reviewComments,
          ),
        ),
        pollRequest(() =>
          ghGet<GhReview[]>(
            `${prPath}/reviews?per_page=100`,
            state.etags.reviews,
          ),
        ),
        state.currentShaState?.sha
          ? pollRequest(() =>
              fetchAllCheckRunsClient(
                pr.owner,
                pr.repo,
                state.currentShaState!.sha,
                state.currentShaState!.checkRunsCache,
                this.logger,
              ),
            )
          : Effect.succeed({
              response: { status: 304 as const },
              stagedCache: undefined,
            }),
      ],
      { concurrency: 4 },
    );

    // Issue/review comment lists: seed on the first tick (nothing emitted),
    // diff + emit on later ticks. consumeCommentList branches on
    // state.initialized, so one call per resource covers both phases. It runs
    // before the checks/reviews seeding below, but the resources are
    // independent and the relative emit order (comments before reviews) is
    // unchanged from the original inline seed/diff blocks.
    yield* this.consumeCommentList(
      commentsRes,
      (etag) => {
        state.etags.issueComments = etag;
      },
      state.issueComments,
      (c) =>
        this.emit(state, formatPRIssueComment(state.slug, pr.pullNumber, c)),
      () => state.initialized,
    );
    yield* this.consumeCommentList(
      reviewCommentsRes,
      (etag) => {
        state.etags.reviewComments = etag;
      },
      state.reviewComments,
      (c) =>
        this.emit(state, formatReviewComment(state.slug, pr.pullNumber, c)),
      () => state.initialized,
    );

    // First tick only seeds cursors so we never replay history.
    if (!state.initialized) {
      this.seedFirstTick(state, reviewsRes, checksRes, stagedCheckRunsCache);
      return;
    }

    // Comment lists were consumed at the top of the tick (seed first tick,
    // diff + emit after); only reviews and checks remain here.
    if (reviewsRes.status === 200) {
      state.etags.reviews = reviewsRes.etag;
      // Same reasoning as the seeding branch: ignore PENDING drafts — they
      // keep the same id when submitted, and emitting "reviewed" on a draft
      // would both be misleading and prevent the real submission event from
      // firing.
      const freshReviews: GhReview[] = [];
      state.reviews.diff(reviewsRes.data.filter(isSubmittedReview), (r) => {
        if (shouldDropBotEvent(r.user)) return;
        freshReviews.push(r);
      });
      yield* Effect.forEach(
        freshReviews,
        (r) => this.emit(state, formatReview(state.slug, pr.pullNumber, r)),
        { discard: true },
      );
    }

    if (checksRes.status === 200) {
      // ETag/page caching is owned by `fetchAllCheckRuns` via
      // `state.currentShaState.checkRunsCache`; nothing to record on
      // `state.etags` here.
      yield* this.consumeCheckRuns(
        state,
        checksRes.data.check_runs,
        checksRes.data.total_count,
      );
    }

    // Commit the deferred check-runs cache only after successfully consuming
    // the response (including the diff branch above).
    this.commitStagedCheckRunsCache(state, stagedCheckRunsCache);
  });

  /**
   * Conditional GET of the PR detail, applying every subscription-state
   * transition it drives: close/merge auto-unsubscribe, the per-head-SHA state
   * reset, and mergeable-state transitions.
   *
   * Returns `false` when the rest of the tick must be skipped — either a
   * malformed payload or a closed PR that was already detached. A 304 (or any
   * non-200) leaves state untouched and continues.
   */
  private readonly refreshPrMetadata = Effect.fn(
    'PRPollingSource.refreshPrMetadata',
  )(function* (
    this: PRPollingSource,
    key: string,
    state: PRSubscriptionState,
    prPath: string,
  ) {
    const { pr } = state;
    const prRes = yield* pollRequest(() =>
      ghGet<GhPullRequest>(prPath, state.etags.pr),
    );
    if (prRes.status !== 200) return true;

    // Validate the state-driving PR payload non-throwingly (never throw on
    // the 200 path — see validateOrSkip). We skip BEFORE writing
    // state.etags.pr, so the PR-detail ETag is not advanced on a bad body —
    // the next tick re-fetches the same resource and re-validates (no
    // strand).
    const parsed = this.validateOrSkip(
      prRes,
      GhPullRequestSchema,
      `Skipping PR poll for ${key}: malformed pull-request payload`,
    );
    if (!parsed) return false;
    const prData = parsed.data;
    state.etags.pr = prRes.etag;
    const newHead = prData.head.sha;
    const newMergeable = prData.mergeable_state;

    // A closed PR cannot produce any later activity worth polling. Handling
    // every closed 200 response here covers both initially-closed and
    // open-to-closed subscriptions without mirroring the remote state locally.
    if (prData.state === 'closed') {
      yield* this.emit(
        state,
        formatPRClosed(state.slug, pr.pullNumber, prData.merged),
      );
      this.detach(key);
      return false;
    }
    // New push invalidates prior CI terminal state — the next completion
    // on the new SHA should re-emit CI progress events. Also drop the
    // per-page check-runs cache: it's keyed only by page number, and the
    // ETags from the previous SHA can never match the new SHA's responses.
    // Letting it linger would cost one wasted If-None-Match per page on
    // the first post-push tick before the cache naturally refreshes. Old
    // SHA's deferred annotations are no longer the user's focus; the new
    // SHA's runs will re-enqueue from the next 200 tick. Replacing the
    // whole per-SHA object (rather than clearing fields one by one) means
    // a future per-SHA field can't be left stale across a push.
    if (state.currentShaState?.sha !== newHead) {
      state.currentShaState = {
        sha: newHead,
        ciStarted: false,
        ciComplete: false,
        ciPassed: false,
        checkRunsCache: undefined,
        pendingAnnotationRuns: [],
      };
    }

    // Mergeable-state transitions: only definite-to-definite reads count,
    // so the seeding tick (and any tick where GitHub returns `'unknown'`)
    // is silent. See `isDefiniteMergeableState` for the rationale.
    if (isDefiniteMergeableState(newMergeable)) {
      const prev = state.mergeableState;
      state.mergeableState = newMergeable;
      if (isDefiniteMergeableState(prev) && prev !== newMergeable) {
        if (newMergeable === 'dirty') {
          yield* this.emit(
            state,
            formatMergeConflictDetected(state.slug, pr.pullNumber, prev),
          );
        } else if (prev === 'dirty') {
          yield* this.emit(
            state,
            formatMergeConflictResolved(
              state.slug,
              pr.pullNumber,
              newMergeable,
            ),
          );
        }
      }
    }
    return true;
  });

  /**
   * First tick for a subscription: seed the review and check-run cursors so
   * pre-subscription history is never replayed, then mark the subscription
   * initialized. Emits nothing. Comment lists are seeded by the shared
   * `consumeCommentList` calls that run before this, on every tick.
   */
  private seedFirstTick(
    state: PRSubscriptionState,
    reviewsRes: ConditionalResponse<GhReview[]>,
    checksRes: ConditionalResponse<{
      total_count: number;
      check_runs: GhCheckRun[];
    }>,
    stagedCheckRunsCache: CheckRunsCache | undefined,
  ): void {
    if (reviewsRes.status === 200) {
      state.etags.reviews = reviewsRes.etag;
      // Skip PENDING: these are the authenticated user's own drafts
      // (only visible via their own token). A review keeps the same ID
      // when it transitions PENDING → APPROVED/CHANGES_REQUESTED/COMMENTED,
      // so if we seed the pending id here the actual submission will be
      // silently deduped later.
      state.reviews.seed(reviewsRes.data.filter(isSubmittedReview));
    }
    if (checksRes.status === 200) {
      // ETag/page caching is owned by `fetchAllCheckRuns` via
      // `state.currentShaState.checkRunsCache`; nothing to record on
      // `state.etags` here.
      const runs = checksRes.data.check_runs;
      for (const r of runs) {
        if (isCheckFailure(r)) {
          state.lastFailedCheckKeys.add(checkKey(r));
        }
        // Seed annotation keys so pre-subscription annotations don't
        // replay; the timestamp in the key lets re-runs re-emit.
        if (
          r.status === 'completed' &&
          (r.output?.annotations_count ?? 0) > 0
        ) {
          state.lastAnnotationKeys.add(checkKey(r));
        }
      }
      if (state.currentShaState?.sha && runs.length > 0) {
        state.currentShaState.ciStarted = true;
      }
      // Seed so pre-existing terminal CI doesn't fire on the next tick —
      // we only surface transitions that happen after subscribe. See
      // `ciTerminalStatus` for the gating rationale (empty/partial run sets,
      // page-shift safety).
      const { complete, passed } = ciTerminalStatus(
        state.currentShaState?.sha,
        runs,
        checksRes.data.total_count,
      );
      if (complete && state.currentShaState) {
        state.currentShaState.ciComplete = true;
        if (passed) {
          state.currentShaState.ciPassed = true;
        }
      }
    }
    // Commit the deferred check-runs cache only after successfully consuming
    // the response.
    this.commitStagedCheckRunsCache(state, stagedCheckRunsCache);
    state.initialized = true;
  }

  /**
   * Diff one tick's check runs against the per-SHA markers and emit the
   * resulting events: the one-shot "CI triggered", new failures (coalesced
   * past {@link COALESCE_THRESHOLD}), the one-shot "CI complete"/"CI passed",
   * and the annotation candidates queued for the post-tick drain.
   */
  private readonly consumeCheckRuns = Effect.fn(
    'PRPollingSource.consumeCheckRuns',
  )(function* (
    this: PRPollingSource,
    state: PRSubscriptionState,
    runs: GhCheckRun[],
    totalCount: number,
  ) {
    const { pr } = state;
    const currentShaState = state.currentShaState;
    const headSha = currentShaState?.sha;
    if (
      currentShaState &&
      headSha &&
      runs.length > 0 &&
      !currentShaState.ciStarted
    ) {
      currentShaState.ciStarted = true;
      yield* this.emit(
        state,
        formatCIStarted(state.slug, pr.pullNumber, headSha, runs, totalCount),
      );
    }

    const { newFailures, currentFailureKeys } = computeNewCheckFailures(
      runs,
      state.lastFailedCheckKeys,
    );
    state.lastFailedCheckKeys = currentFailureKeys;
    if (newFailures.length >= COALESCE_THRESHOLD) {
      yield* this.emit(
        state,
        formatCheckFailureSummary(state.slug, pr.pullNumber, newFailures),
      );
    } else {
      for (const r of newFailures) {
        yield* this.emit(
          state,
          formatCheckFailure(state.slug, pr.pullNumber, r),
        );
      }
    }

    // Emit two one-shot events per head SHA: "CI complete" on first
    // terminal state (any conclusion), then "CI passed" the first time
    // all checks pass (which may happen via a later rerun). Each is
    // deduped against its own marker so a rerun turning red→green still
    // emits "CI passed" even after "CI complete" already fired.
    //
    // See `ciTerminalStatus` for the gating rationale (empty/partial run
    // sets, page-shift safety).
    const { complete, passed } = ciTerminalStatus(headSha, runs, totalCount);
    if (complete && currentShaState && headSha) {
      if (!currentShaState.ciComplete) {
        currentShaState.ciComplete = true;
        yield* this.emit(
          state,
          formatCIComplete(state.slug, pr.pullNumber, headSha, runs),
        );
      }
      if (!currentShaState.ciPassed && passed) {
        currentShaState.ciPassed = true;
        yield* this.emit(
          state,
          formatCIPassed(state.slug, pr.pullNumber, headSha, runs),
        );
      }
    }

    // Annotations are emitted independently of failures: they also surface
    // on passing checks (lint suggestions, custom workflow advisories).
    // Enqueue here, drain in `afterTick` — the drain runs on every tick
    // (including 304) so excess candidates aren't stranded once check-runs
    // settle.
    this.enqueueAnnotationCandidates(state, runs);
  });

  /**
   * Commit the check-runs page cache staged by `fetchAllCheckRuns`. The single
   * owner of that write, called from both tick shapes (seeding and diffing) at
   * the same point: only after the response has been fully consumed. See
   * `fetchAllCheckRuns` for why the commit is deferred — advancing the cache
   * while the consume step never ran would make the next tick 304 and silently
   * skip the missed transitions.
   */
  private commitStagedCheckRunsCache(
    state: PRSubscriptionState,
    stagedCheckRunsCache: CheckRunsCache | undefined,
  ): void {
    if (stagedCheckRunsCache !== undefined && state.currentShaState) {
      state.currentShaState.checkRunsCache = stagedCheckRunsCache;
    }
  }

  /**
   * Replace `lastAnnotationKeys` with this tick's set and enqueue any newly-
   * appeared annotated runs. Replace-each-tick semantics (mirroring
   * `lastFailedCheckKeys`) keep the set bounded by the head SHA's check-run
   * count — no FIFO eviction, no risk of an evicted-then-rediscovered run
   * re-emitting duplicates against an unchanged check-runs response.
   */
  private enqueueAnnotationCandidates(
    state: PRSubscriptionState,
    runs: ReadonlyArray<GhCheckRun>,
  ): void {
    const currentShaState = state.currentShaState;
    if (!currentShaState) return;
    const { toAppend, replacementsByIndex, newCurrentKeys } =
      planAnnotationCandidates(
        runs,
        state.lastAnnotationKeys,
        currentShaState.pendingAnnotationRuns,
      );
    for (const [index, run] of replacementsByIndex) {
      currentShaState.pendingAnnotationRuns[index] = run;
    }
    currentShaState.pendingAnnotationRuns.push(...toAppend);
    state.lastAnnotationKeys = newCurrentKeys;
  }

  private readonly drainAnnotationQueues = Effect.fn(
    'PRPollingSource.drainAnnotationQueues',
  )(function* (
    this: PRPollingSource,
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
    now?: number,
  ) {
    const at = now ?? (yield* Clock.currentTimeMillis);
    const pendingEntries = this.orderAnnotationDrainEntries(entries, at);
    if (pendingEntries.length === 0) return;

    const claimsByKey = new Map<string, number>();
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      for (const [key, state] of pendingEntries) {
        if (!this.has(key)) continue;
        if ((state.currentShaState?.pendingAnnotationRuns.length ?? 0) === 0) {
          continue;
        }
        const claims = claimsByKey.get(key) ?? 0;
        if (claims >= MAX_ANNOTATION_RUNS_PER_SUBSCRIPTION_TICK) continue;
        // Only `drainNextAnnotationRun`'s own rate-limit re-raise is a
        // typed failure here; a defect stays a defect and ends the round.
        const drained = yield* this.drainNextAnnotationRun(state, at).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTag('PollHookRejected', (failure) =>
            Effect.succeed({ ok: false as const, failure }),
          ),
        );
        if (!drained.ok) {
          // The failure time, not the round's start: draining can run a slow
          // poll and several annotation pages, and timing the backoff from
          // `at` would put skipPollUntilMs in the past and retry at once.
          const failedAt = yield* Clock.currentTimeMillis;
          yield* this.handleFailure(
            key,
            state,
            drained.failure.cause,
            failedAt,
          );
          if (drained.failure.cause instanceof GitHubRateLimitError) {
            this.nextAnnotationDrainKey = key;
            return;
          }
        } else if (!drained.value) {
          this.nextAnnotationDrainKey = key;
          return;
        }
        claimsByKey.set(key, claims + 1);
        madeProgress = true;
      }
    }
    this.advanceAnnotationDrainStart(pendingEntries);
  });

  private orderAnnotationDrainEntries(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
    now: number,
  ): Array<readonly [string, PRSubscriptionState]> {
    const pendingEntries = entries.filter(
      ([key, state]) =>
        this.has(key) &&
        state.skipPollUntilMs <= now &&
        (state.currentShaState?.pendingAnnotationRuns.length ?? 0) > 0,
    );
    if (pendingEntries.length === 0) return [];
    const startIndex = this.nextAnnotationDrainKey
      ? pendingEntries.findIndex(([key]) => key === this.nextAnnotationDrainKey)
      : -1;
    if (startIndex <= 0) return pendingEntries;
    return [
      ...pendingEntries.slice(startIndex),
      ...pendingEntries.slice(0, startIndex),
    ];
  }

  private advanceAnnotationDrainStart(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
  ): void {
    if (entries.length === 0) {
      this.nextAnnotationDrainKey = undefined;
      return;
    }
    this.nextAnnotationDrainKey = entries[1]?.[0] ?? entries[0][0];
  }

  /**
   * Drain one queued run by hitting the annotations endpoint. Errors are
   * isolated per-fetch: annotations are best-effort, so a single bad check
   * must not detach the whole PR subscription.
   *
   * - Success: emit, remove from queue.
   * - `GitHubPermanentError` (404/410/422): log + drop. Retrying won't help.
   * - `GitHubAuthError` (401/403): log + drop. Almost always a permission-
   *   scoped token; the main poll path handles genuinely bad tokens.
   * - `GitHubRateLimitError`: propagate so the subscription-level backoff
   *   governs every GitHub endpoint.
   * - Anything else (network, timeout): rotate to the back of the queue.
   */
  private readonly drainNextAnnotationRun = Effect.fn(
    'PRPollingSource.drainNextAnnotationRun',
  )(function* (this: PRPollingSource, state: PRSubscriptionState, now: number) {
    const run = state.currentShaState?.pendingAnnotationRuns[0];
    if (!run) return true;
    const { pr } = state;
    const fetched = yield* pollRequest(() =>
      fetchAnnotationsClient(
        pr.owner,
        pr.repo,
        run.id,
        this.logger,
        SharedAnnotationFetchBudget,
        now,
      ),
    ).pipe(
      Effect.map((annotations) => ({ ok: true as const, annotations })),
      Effect.catchTag('PollHookRejected', (failure) =>
        Effect.succeed({ ok: false as const, failure }),
      ),
    );
    if (fetched.ok) {
      this.removePendingAnnotationRun(state, run.id);
      if (fetched.annotations.length > 0) {
        yield* this.emitCheckAnnotations(state, run, fetched.annotations);
      }
      return true;
    }
    const { failure } = fetched;
    const err = failure.cause;
    if (err instanceof AnnotationFetchBudgetExhaustedError) return false;
    if (err instanceof GitHubRateLimitError) return yield* Effect.fail(failure);
    if (err instanceof GitHubPermanentError || err instanceof GitHubAuthError) {
      const reason =
        err instanceof GitHubAuthError ? 'forbidden' : 'unavailable';
      this.logger.warn(`Annotations for check ${run.id} ${reason}; dropping.`, {
        data: err,
      });
      this.removePendingAnnotationRun(state, run.id);
      return true;
    }
    this.removePendingAnnotationRun(state, run.id);
    state.currentShaState?.pendingAnnotationRuns.push(run);
    this.logger.warn(
      `Annotation fetch for check ${run.id} failed; rotating to back of queue`,
      { data: err },
    );
    return true;
  });

  private removePendingAnnotationRun(
    state: PRSubscriptionState,
    runId: number,
  ): void {
    if (!state.currentShaState) return;
    state.currentShaState.pendingAnnotationRuns =
      state.currentShaState.pendingAnnotationRuns.filter((p) => p.id !== runId);
  }

  private readonly emitCheckAnnotations = Effect.fn(
    'PRPollingSource.emitCheckAnnotations',
  )(function* (
    this: PRPollingSource,
    state: PRSubscriptionState,
    run: GhCheckRun,
    annotations: readonly GhCheckAnnotation[],
  ) {
    for (const listener of state.listeners) {
      const minLevel =
        state.annotationLevelByListener.get(listener) ??
        DEFAULT_CHECK_ANNOTATION_LEVEL;
      const visibleAnnotations = annotations.filter((annotation) =>
        includesCheckAnnotationLevel(annotation.annotation_level, minLevel),
      );
      if (visibleAnnotations.length === 0) continue;
      const visibleRun: GhCheckRun = {
        ...run,
        output: {
          ...run.output,
          annotations_count: visibleAnnotations.length,
        },
      };
      yield* this.emitToListener(
        listener,
        formatCheckAnnotations(
          state.slug,
          state.pr.pullNumber,
          visibleRun,
          visibleAnnotations,
        ),
      );
    }
  });
}

/** Process-wide singleton. */
export const SharedPRPollingSource = new PRPollingSource();
