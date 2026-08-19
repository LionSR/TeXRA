/**
 * diff-match-patch helpers.
 *
 * dmp is a metric and fuzzy-patch library here, not a text pipeline: every
 * diff a user or a model reads comes from `@utils/text/unifiedDiff`. What
 * survives here is what dmp does that jsdiff does not — a Levenshtein
 * distance, a cheap line-change count for run bookkeeping, and fuzzy patch
 * application against a file that moved under us.
 */

// Third-party imports
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';

// Local imports - utils
import { countLines } from './stringUtils';

interface DiffLineChanges {
  added: number;
  removed: number;
}

interface PatchApplyResult {
  content: string;
  results: boolean[];
}

/**
 * Character diff with diff-match-patch's line-check speedup, no semantic
 * cleanup — the shape both metric callers below want.
 */
function diffChars(oldText: string, newText: string) {
  return new diff_match_patch().diff_main(oldText, newText, true);
}

/** diff-match-patch Levenshtein distance between two strings. */
export function diffTextLevenshtein(oldText: string, newText: string): number {
  return new diff_match_patch().diff_levenshtein(diffChars(oldText, newText));
}

/**
 * Approximate added/removed line counts for run bookkeeping.
 *
 * Deliberately not the numbers shown beside a diff body: those come from
 * `computeLineChangeSummary`, folded over the very hunks the reader sees.
 */
export function diffLineChanges(
  oldText: string,
  newText: string,
): DiffLineChanges {
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffChars(oldText, newText)) {
    if (op === DIFF_INSERT) {
      added += countLines(text);
    } else if (op === DIFF_DELETE) {
      removed += countLines(text);
    }
  }
  return { added, removed };
}

/**
 * Apply the patch from oldText to newText onto a target string.
 *
 * dmp's fuzzy `patch_apply` is the point: the target is the current file,
 * which may have moved since the edit was proposed.
 */
export function applyPatchToText(
  oldText: string,
  newText: string,
  targetText: string,
): PatchApplyResult {
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(oldText, newText);
  const [content, results] = dmp.patch_apply(patches, targetText);
  return { content, results };
}
