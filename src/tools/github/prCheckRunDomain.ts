/**
 * Pure domain rules for GitHub PR check runs.
 *
 * No I/O, no subscription state, no `this`: every function here is a total
 * transformation over plain check-run data, so the CI-status semantics (what
 * counts as a failure, when CI is "complete"/"passed", which runs are newly
 * failed, which annotated runs to enqueue) can be reasoned about and unit
 * tested in isolation. `PRPollingSource` calls these and commits the results
 * to its mutable per-subscription state.
 */

import type { GhCheckRun } from './prTypes';

/** Conclusions GitHub treats as non-blocking (success / advisory / skipped). */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'neutral',
  'skipped',
]);

export function isPassingConclusion(conclusion: string | null): boolean {
  return conclusion !== null && PASSING_CONCLUSIONS.has(conclusion);
}

/** A completed check run with a non-passing conclusion. */
export function isCheckFailure(r: GhCheckRun): boolean {
  if (r.status !== 'completed') return false;
  const c = r.conclusion;
  return c === 'failure' || c === 'timed_out' || c === 'cancelled';
}

/**
 * Stable per-run identity that also changes across reruns: the same check id
 * with a new `completed_at` is treated as a distinct observation so a rerun
 * re-emits failures/annotations.
 */
export function checkKey(r: GhCheckRun): string {
  return `${r.id}:${r.completed_at ?? ''}`;
}

/**
 * Compute the CI-terminal status for a tick.
 *
 * `complete` is true only when we have the head SHA, a non-empty run set,
 * the full set (length >= total_count — the caller dedupes by id and uses the
 * latest total_count, so this is safe against mid-walk page shifts), and every
 * run has completed. `passed` requires `complete` plus every run passing.
 */
export function ciTerminalStatus(
  headSha: string | undefined,
  runs: GhCheckRun[],
  totalCount: number,
): { complete: boolean; passed: boolean } {
  const complete =
    !!headSha &&
    runs.length > 0 &&
    runs.length >= totalCount &&
    runs.every((r) => r.status === 'completed');
  const passed =
    complete && runs.every((r) => isPassingConclusion(r.conclusion));
  return { complete, passed };
}

/**
 * Diff this tick's failing runs against the previously-seen failure keys.
 * Returns the newly-appeared failures (to emit) and the full current key set
 * (which the caller commits as the new `lastFailedCheckKeys`).
 */
export function computeNewCheckFailures(
  runs: ReadonlyArray<GhCheckRun>,
  lastFailedCheckKeys: Set<string>,
): { newFailures: GhCheckRun[]; currentFailureKeys: Set<string> } {
  const newFailures: GhCheckRun[] = [];
  const currentFailureKeys = new Set<string>();
  for (const r of runs) {
    if (!isCheckFailure(r)) continue;
    const key = checkKey(r);
    currentFailureKeys.add(key);
    if (!lastFailedCheckKeys.has(key)) newFailures.push(r);
  }
  return { newFailures, currentFailureKeys };
}

/** The mutations the caller applies to its annotation queue, plus the next key set. */
interface AnnotationQueuePlan {
  /** Newly-appeared annotated runs to append to the pending queue. */
  toAppend: GhCheckRun[];
  /**
   * In-place replacements keyed by the run's index in the *prior* pending
   * queue. A rerun (new `completed_at` for an already-pending id) replaces the
   * queued entry's run reference so the headline metadata matches what the
   * fetch will actually return — without ever queueing the same id twice.
   */
  replacementsByIndex: Map<number, GhCheckRun>;
  /** The set the caller commits as the new `lastAnnotationKeys`. */
  newCurrentKeys: Set<string>;
}

/**
 * Plan annotation-queue updates for a tick. Pure: it reads the current pending
 * queue (by value) and returns the appends/replacements for the caller to
 * apply, so the subtle replace-by-id-on-rerun semantics live in one testable
 * place.
 *
 * `pendingIndexById` is built once from the prior queue and never updated
 * during the scan, so a run appended this tick is never replaced in the same
 * tick, and a duplicate id within `runs` resolves last-one-wins at its index —
 * matching the original in-place pass exactly.
 */
export function planAnnotationCandidates(
  runs: ReadonlyArray<GhCheckRun>,
  lastAnnotationKeys: Set<string>,
  currentPendingRuns: ReadonlyArray<GhCheckRun>,
): AnnotationQueuePlan {
  const pendingIndexById = new Map<number, number>();
  for (const [i, run] of currentPendingRuns.entries()) {
    pendingIndexById.set(run.id, i);
  }

  const newCurrentKeys = new Set<string>();
  const toAppend: GhCheckRun[] = [];
  const replacementsByIndex = new Map<number, GhCheckRun>();

  for (const run of runs) {
    if (run.status !== 'completed') continue;
    if ((run.output?.annotations_count ?? 0) <= 0) continue;
    const key = checkKey(run);
    newCurrentKeys.add(key);
    if (lastAnnotationKeys.has(key)) continue;
    const existingIdx = pendingIndexById.get(run.id);
    if (existingIdx !== undefined) {
      replacementsByIndex.set(existingIdx, run);
      continue;
    }
    toAppend.push(run);
  }

  return { toAppend, replacementsByIndex, newCurrentKeys };
}
