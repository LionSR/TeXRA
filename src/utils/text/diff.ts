// Third-party imports
import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';

// Local imports - utils
import { countLines } from './stringUtils';

export { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT };

export type TextDiff = ReturnType<
  InstanceType<typeof diff_match_patch>['diff_main']
>[number];

export interface TextDiffOptions {
  /**
   * Run diff-match-patch semantic cleanup after diffing.
   *
   * Defaults to false so callers preserve the library's raw diff unless they
   * explicitly need the edit-preview behavior.
   */
  cleanupSemantic?: boolean;
}

export interface CharDiffOptions extends TextDiffOptions {
  /**
   * Pass diff-match-patch's line-check speedup flag to `diff_main`.
   *
   * Defaults to false for explicit raw char-mode diffing. Callers preserving
   * diff-match-patch's omitted-argument behavior pass `checkLines: true`.
   */
  checkLines?: boolean;
}

export interface DiffLineChanges {
  added: number;
  removed: number;
}

export interface PatchApplyResult {
  content: string;
  results: boolean[];
}

/**
 * Compute a character diff. By default this is the raw diff-match-patch
 * `diff_main(oldText, newText, false)` behavior.
 */
export function diffTextByChar(
  oldText: string,
  newText: string,
  options: CharDiffOptions = {},
): TextDiff[] {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldText, newText, options.checkLines ?? false);
  if (options.cleanupSemantic) {
    dmp.diff_cleanupSemantic(diffs);
  }
  return diffs;
}

/**
 * Compute a line-mode diff by mapping whole lines to synthetic characters
 * before running `diff_main`. By default no semantic cleanup is applied.
 */
export function diffTextByLine(
  oldText: string,
  newText: string,
  options: TextDiffOptions = {},
): TextDiff[] {
  const dmp = new diff_match_patch();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(
    oldText,
    newText,
  );
  const diffs = dmp.diff_main(chars1, chars2, false);
  if (options.cleanupSemantic) {
    dmp.diff_cleanupSemantic(diffs);
  }
  dmp.diff_charsToLines_(diffs, lineArray);
  return diffs;
}

/**
 * Compute diff-match-patch Levenshtein distance directly from two strings.
 */
export function diffTextLevenshtein(
  oldText: string,
  newText: string,
  options: CharDiffOptions = {},
): number {
  const diffs = diffTextByChar(oldText, newText, options);
  return new diff_match_patch().diff_levenshtein(diffs);
}

/**
 * Compute line-change stats from a char diff. Defaults to raw char-mode diffing
 * with no semantic cleanup; callers opt in to cleanup explicitly.
 */
export function diffLineChanges(
  oldText: string,
  newText: string,
  options: CharDiffOptions = {},
): DiffLineChanges {
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffTextByChar(oldText, newText, options)) {
    if (op === DIFF_INSERT) {
      added += countLines(text);
    } else if (op === DIFF_DELETE) {
      removed += countLines(text);
    }
  }
  return { added, removed };
}

/** Build a diff-match-patch patch text, or undefined when there is no patch. */
export function makePatchText(
  oldText: string,
  newText: string,
): string | undefined {
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(oldText, newText);
  return patches.length > 0 ? dmp.patch_toText(patches) : undefined;
}

/** Apply the patch from oldText to newText onto a target string. */
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
