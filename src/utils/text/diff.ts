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

type DiffMatchPatch = InstanceType<typeof diff_match_patch>;

export type TextDiff = ReturnType<DiffMatchPatch['diff_main']>[number];

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

function createDiffMatcher(): DiffMatchPatch {
  return new diff_match_patch();
}

function applySemanticCleanup(
  dmp: DiffMatchPatch,
  diffs: TextDiff[],
): TextDiff[] {
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
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
  const dmp = createDiffMatcher();
  const diffs = dmp.diff_main(oldText, newText, options.checkLines ?? false);
  if (options.cleanupSemantic === true) {
    applySemanticCleanup(dmp, diffs);
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
  const dmp = createDiffMatcher();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(
    oldText,
    newText,
  );
  const diffs = dmp.diff_main(chars1, chars2, false);
  if (options.cleanupSemantic === true) {
    applySemanticCleanup(dmp, diffs);
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
  return createDiffMatcher().diff_levenshtein(diffs);
}

/** Count added and removed lines from a diff. */
function countDiffLineChanges(diffs: TextDiff[]): DiffLineChanges {
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffs) {
    if (op === DIFF_INSERT) {
      added += countLines(text);
    } else if (op === DIFF_DELETE) {
      removed += countLines(text);
    }
  }
  return { added, removed };
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
  return countDiffLineChanges(diffTextByChar(oldText, newText, options));
}

/** Build a diff-match-patch patch text, or undefined when there is no patch. */
export function makePatchText(
  oldText: string,
  newText: string,
): string | undefined {
  const dmp = createDiffMatcher();
  const patches = dmp.patch_make(oldText, newText);
  return patches.length > 0 ? dmp.patch_toText(patches) : undefined;
}

/** Apply the patch from oldText to newText onto a target string. */
export function applyPatchToText(
  oldText: string,
  newText: string,
  targetText: string,
): PatchApplyResult {
  const dmp = createDiffMatcher();
  const patches = dmp.patch_make(oldText, newText);
  const [content, results] = dmp.patch_apply(patches, targetText);
  return { content, results };
}
