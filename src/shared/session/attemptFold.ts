/**
 * The attempt vocabulary the session's two attempt rows share.
 *
 * `child.turn` says which turn of which child-run attempt is open and which
 * one settled, on the child's own aggregate. `workflow.attempt` says how far
 * one `agent()` call's attempt series got, on the parent's checkpoint
 * aggregate. The two facts stay apart — one is the child's own bookkeeping,
 * the other the parent's launch authorization, and the parent's survives the
 * child's deletion — but they name an attempt the same way and fold the same
 * way, so the key and the fold live here once instead of being hand-rolled
 * beside each row.
 */

/**
 * One attempt's structural identity: `key` names the series it belongs to (a
 * child run's attempt id, a workflow call's key) and `index` its position in
 * that series (the turn within the attempt, the attempt within the call).
 * Structural, so the same attempt always folds to the same identity and a
 * later series that reuses an id never collides with it.
 */
export interface AttemptKey {
  readonly key: string;
  readonly index: number;
}

const sameAttempt = (a: AttemptKey, b: AttemptKey): boolean =>
  a.key === b.key && a.index === b.index;

/**
 * Fold an aggregate's attempt rows, in commit order, into what its series
 * came to: the attempt still open, the newest one that settled, and how far
 * the series ever got.
 *
 * `select` maps a row to the attempt it names and whether that row closes it;
 * every other row answers null and is skipped. A row type whose rows only
 * ever open an attempt (a workflow call's mark says a launch happened, never
 * that it ended) always answers `settled: false`, and its caller reads
 * `highest`.
 *
 * `highest` is the greatest `index` the selected rows named, open or settled,
 * and is meaningful for a selector that reads a single series; a selector
 * spanning several (a child run's successive attempts) reads `open` and
 * `settled` instead.
 */
export function foldAttempts<T>(
  rows: readonly T[],
  select: (row: T) => { attempt: AttemptKey; settled: boolean } | null,
): {
  readonly open: AttemptKey | null;
  readonly settled: AttemptKey | null;
  readonly highest: AttemptKey | null;
} {
  let open: AttemptKey | null = null;
  let settled: AttemptKey | null = null;
  let highest: AttemptKey | null = null;
  for (const row of rows) {
    const selected = select(row);
    if (selected === null) continue;
    const attempt = selected.attempt;
    if (highest === null || attempt.index > highest.index) highest = attempt;
    if (!selected.settled) {
      open = attempt;
      continue;
    }
    settled = attempt;
    if (open !== null && sameAttempt(open, attempt)) open = null;
  }
  return { open, settled, highest };
}
