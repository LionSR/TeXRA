// Host-neutral "which active children vanished" diff. The single production
// caller is SessionFactApplier (src/controllers/session/), which serves both
// the webview progress-view backend and the CLI TUI through the shared
// SessionFact channel — hosts no longer compute this previous-vs-next
// id-set diff for subagent activity themselves. This module owns the one
// comparison so the algorithm stays single and correct.
//
// NO host imports here (no vscode / electron / ink / immer): the diff is a
// pure function over plain values.

/** Anything with a stable per-execution id can be diffed by this reducer. */
export interface HasExecutionId {
  readonly executionId: string;
}

/**
 * Diff two active-child snapshots by executionId, returning ids present in
 * `previous` but absent from `next` — i.e. children that finished between
 * the two snapshots. The caller decides what "vanished" means (count it,
 * persist a transcript row, prune a side map, or several). Pure: never
 * mutates either input.
 */
export function diffActiveChildren(
  previous: readonly HasExecutionId[],
  next: readonly HasExecutionId[],
): ReadonlySet<string> {
  const nextIds = new Set(next.map((child) => child.executionId));
  return new Set(
    previous.map((child) => child.executionId).filter((id) => !nextIds.has(id)),
  );
}
