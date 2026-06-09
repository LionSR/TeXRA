/** Levenshtein edit distance between two strings (two-row DP, O(min memory)). */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
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
