/**
 * Edit distance between two strings where an adjacent transposition counts as
 * one edit (optimal string alignment), so `lsit` is one typo away from `list`
 * rather than two. Callers compare short tokens (command and subcommand names)
 * against a handful of candidates, so the straightforward O(n·m) matrix is the
 * whole cost.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Row i starts at i (i deletions); row 0 is j (j insertions).
  const d = Array.from({ length: a.length + 1 }, (_row, i) =>
    Array.from({ length: b.length + 1 }, (_cell, j) => (i === 0 ? j : i)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Maximum edit distance at which `candidate` still counts as a plausible typo
 * of `token` — a third of the longer string, but at least 1. Shared by the
 * CLI subcommand and slash-command "did you mean" suggestions.
 */
export function typoSuggestionThreshold(
  token: string,
  candidate: string,
): number {
  return Math.max(1, Math.floor(Math.max(token.length, candidate.length) / 3));
}
