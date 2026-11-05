/**
 * diff-match-patch helpers.
 *
 * dmp is a metric library here, not a text pipeline: every diff a user or a
 * model reads, and every line count beside one, comes from the harness's
 * `buildDiffHunks`. What survives here is what dmp does that jsdiff does not:
 * a Levenshtein distance.
 */

// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

/** diff-match-patch Levenshtein distance between two strings. */
export function diffTextLevenshtein(oldText: string, newText: string): number {
  const dmp = new diff_match_patch();
  // Line-check speedup, no semantic cleanup.
  return dmp.diff_levenshtein(dmp.diff_main(oldText, newText, true));
}
