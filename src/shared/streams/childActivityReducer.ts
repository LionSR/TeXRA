// Host-neutral "which active children vanished" diff, shared by the webview
// progress-view backend and the CLI TUI. Both hosts independently computed
// this same previous-vs-next id-set diff for subagent/process activity; this
// module owns the one comparison so hosts stay on a single correct algorithm.
//
// NO host imports here (no vscode / electron / ink / immer): the diff is a
// pure function over plain values.

/** Anything with a stable per-execution id can be diffed by this reducer. */
export interface HasExecutionId {
  readonly executionId: string;
}

export interface ChildActivityDiff<T extends HasExecutionId> {
  /** The next active-child list, passed through unchanged. */
  readonly next: readonly T[];
  /**
   * Ids present in `previous` but absent from `next` — i.e. children that
   * finished between the two snapshots. The caller decides what "vanished"
   * means (count it, persist a transcript row, prune a side map, or several).
   */
  readonly vanishedIds: ReadonlySet<string>;
}

/**
 * Diff two active-child snapshots by executionId. Pure: never mutates either
 * input.
 */
export function diffActiveChildren<T extends HasExecutionId>(
  previous: readonly T[],
  next: readonly T[],
): ChildActivityDiff<T> {
  const nextIds = new Set(next.map((child) => child.executionId));
  const vanishedIds = new Set(
    previous.map((child) => child.executionId).filter((id) => !nextIds.has(id)),
  );
  return { next, vanishedIds };
}
