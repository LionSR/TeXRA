/**
 * Levenshtein edit distance between two strings, over a single rolling row of
 * the dynamic-programming matrix. Callers compare short tokens (command and
 * subcommand names) against a handful of candidates, so the straightforward
 * O(n·m) form is the whole cost.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: a.length + 1 }, (_unused, index) => index);
  for (let j = 1; j <= b.length; j++) {
    let diagonal = row[0];
    row[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const above = row[i];
      row[i] =
        a[i - 1] === b[j - 1]
          ? diagonal
          : Math.min(diagonal, above, row[i - 1]) + 1;
      diagonal = above;
    }
  }
  return row[a.length];
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
