/**
 * The attempt vocabulary of `child.turn`, which says which turn of which
 * child-run attempt is open and which one settled, on the child's own
 * aggregate.
 */

/**
 * One attempt's structural identity: `key` names the series it belongs to (a
 * child run's attempt id) and `index` its position in that series (the turn
 * within the attempt). Structural, so the same attempt always folds to the same identity and a
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
 * came to: the attempt still open and the newest one that settled.
 *
 * `select` maps a row to the attempt it names and whether that row closes it;
 * every other row answers null and is skipped.
 */
export function foldAttempts<T>(
  rows: readonly T[],
  select: (row: T) => { attempt: AttemptKey; settled: boolean } | null,
): {
  readonly open: AttemptKey | null;
  readonly settled: AttemptKey | null;
} {
  let open: AttemptKey | null = null;
  let settled: AttemptKey | null = null;
  for (const row of rows) {
    const selected = select(row);
    if (selected === null) continue;
    const attempt = selected.attempt;
    if (!selected.settled) {
      open = attempt;
      continue;
    }
    settled = attempt;
    if (open !== null && sameAttempt(open, attempt)) open = null;
  }
  return { open, settled };
}
