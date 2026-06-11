/** Levenshtein edit distance between two strings (via `fastest-levenshtein`). */
export { distance as editDistance } from 'fastest-levenshtein';

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
