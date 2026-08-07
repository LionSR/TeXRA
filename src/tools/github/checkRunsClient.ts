/**
 * GitHub check-runs & annotations transport for the PR poller.
 *
 * Infrastructure layer: everything here talks to the GitHub REST API and
 * manages the conditional-request (ETag) caching that keeps steady-state
 * polling cheap. It owns no subscription state — callers pass in the per-PR
 * check-runs cache and receive a staged replacement to commit once they've
 * consumed the response. Keeping this separate from `PRPollingSource` lets the
 * pagination / cache-coherence reasoning be unit-tested without a live poller.
 */

import type { AgentTrace } from '@agent/trace';

import {
  AnnotationFetchBudget,
  AnnotationFetchBudgetExhaustedError,
} from './annotationFetchBudget';
import { ghGet, type ConditionalResponse } from './githubClient';
import type { GhCheckAnnotation, GhCheckRun } from './prTypes';

// GitHub caps the check-runs endpoint at 100 per page.
const CHECK_RUNS_PAGE_SIZE = 100;
// Hard ceiling on how many check-runs pages we'll walk in a single fetch.
// 50 pages = 5,000 runs — well above any realistic monorepo matrix build.
// Without a cap a malformed/runaway `total_count` could fan out into
// hundreds of GETs per tick.
const MAX_CHECK_RUNS_PAGES = 50;
// Use GitHub's maximum page size so filtering by level does not miss failures
// that appear after a long run of warnings or notices.
const ANNOTATIONS_PAGE_SIZE = 100;
// Same order of magnitude as the check-runs page cap. This is a malformed
// response guard, not a normal truncation policy.
const MAX_ANNOTATION_PAGES_PER_RUN = 50;

/**
 * Per-page cache for the paginated check-runs endpoint. Single-page PRs touch
 * only page 1 so still get the cheap 304 fast path; multi-page PRs issue
 * conditional GETs per page so steady-state ticks make N HEAD-cheap 304s
 * instead of N full-page GETs.
 *
 * `lastTotalCount` is the most recent `total_count` from a 200 response; it
 * tells us how many pages to walk when page 1 returns 304.
 *
 * Kept as a standalone type so the per-page cache shape remains explicit
 * without coupling it to poller subscription state.
 */
interface CheckRunsCachePage {
  etag?: string;
  runs: GhCheckRun[];
}

export interface CheckRunsCache {
  pages: Map<number, CheckRunsCachePage>;
  lastTotalCount: number;
}

interface FetchAllCheckRunsResult {
  response: ConditionalResponse<{
    total_count: number;
    check_runs: GhCheckRun[];
  }>;
  /**
   * New per-page cache value to commit only after the caller has successfully
   * consumed the response. `undefined` means "no change" — either the
   * single-page 304 fast path (existing cache is still valid) or this function
   * itself short-circuited before fetching anything.
   *
   * Deferring the commit prevents a sibling rejection in the caller's
   * `Promise.all` from advancing the cache while the diff branch never runs: a
   * stale cache + 304 next tick would silently swallow check-run transitions.
   */
  stagedCache?: CheckRunsCache;
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
export async function fetchAllCheckRuns(
  owner: string,
  repo: string,
  sha: string,
  cache: CheckRunsCache | undefined,
  logger: AgentTrace,
): Promise<FetchAllCheckRunsResult> {
  const basePath = `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}`;

  // Seed a scratch cache we'll stage on the return value. We rebuild from
  // scratch each tick (rather than mutating in-place) so any pages dropped
  // on this tick — e.g. new push reduced page count from 5 to 3 — don't
  // leave stale entries behind.
  const nextPages = new Map<number, CheckRunsCachePage>();

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
    const pageEtag = cache?.pages.get(page)?.etag;
    const res = await ghGet<{
      total_count: number;
      check_runs: GhCheckRun[];
    }>(`${basePath}&page=${page}`, pageEtag);
    if (res.status === 304) {
      // Reuse cached page. Carry forward the ETag we sent.
      const cachedRuns = cache?.pages.get(page)?.runs ?? [];
      nextPages.set(page, { etag: pageEtag, runs: cachedRuns });
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
    nextPages.set(page, { etag: res.etag, runs: res.data.check_runs });
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
    cache.pages.size === 1
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
    logger.warn(
      `Pagination cap hit for ${owner}/${repo}@${sha.slice(0, 7)} check-runs.`,
      {
        data: {
          totalCount: seedTotal,
          neededPages: totalPages,
          cappedAt: MAX_CHECK_RUNS_PAGES,
        },
      },
    );
    totalPages = MAX_CHECK_RUNS_PAGES;
  }
  if (totalPages > 1) {
    logger.info(
      `Pagination for ${owner}/${repo}@${sha.slice(0, 7)} check-runs.`,
      {
        data: { totalCount: seedTotal, totalPages },
      },
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
        logger.warn(
          `Pagination cap hit mid-walk for ${owner}/${repo}@${sha.slice(0, 7)} check-runs.`,
          {
            data: {
              totalCount: latestTotal,
              neededPages: newTotalPages,
              cappedAt: MAX_CHECK_RUNS_PAGES,
            },
          },
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
  const stagedCache: CheckRunsCache = {
    pages: nextPages,
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

/**
 * Fetch all annotations for a check-run, walking pages until a short page or
 * the per-run page cap. Each page claims one unit from the shared annotation
 * fetch `budget`; when the budget is exhausted mid-walk we throw
 * `AnnotationFetchBudgetExhaustedError` so the caller can defer the run rather
 * than partially emit.
 */
export async function fetchAnnotations(
  owner: string,
  repo: string,
  checkRunId: number,
  logger: AgentTrace,
  budget: AnnotationFetchBudget,
  now = Date.now(),
): Promise<GhCheckAnnotation[]> {
  const annotations: GhCheckAnnotation[] = [];
  for (let page = 1; page <= MAX_ANNOTATION_PAGES_PER_RUN; page += 1) {
    if (!budget.tryClaim(now)) {
      throw new AnnotationFetchBudgetExhaustedError();
    }
    const path = `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=${ANNOTATIONS_PAGE_SIZE}&page=${page}`;
    const res = await ghGet<GhCheckAnnotation[]>(path);
    if (res.status !== 200) return annotations;
    annotations.push(...res.data);
    if (res.data.length < ANNOTATIONS_PAGE_SIZE) return annotations;
  }
  logger.warn(
    `Reached annotation page cap (${MAX_ANNOTATION_PAGES_PER_RUN}) for check ${checkRunId}; emitting fetched annotations only.`,
  );
  return annotations;
}
