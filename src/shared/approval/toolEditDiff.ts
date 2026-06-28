import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';

import type { LineChanges } from '@shared/schemas/lineChanges';
import { countLines } from '@utils/text/stringUtils';

function createSemanticDiffs(
  original: string,
  proposed: string,
): ReturnType<InstanceType<typeof diff_match_patch>['diff_main']> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}

export function computeLineChangeSummary(
  original: string,
  proposed: string,
): LineChanges {
  if (original === proposed) {
    return { added: 0, removed: 0 };
  }

  const diffs = createSemanticDiffs(original, proposed);

  let added = 0;
  let removed = 0;

  for (const [type, text] of diffs) {
    if (type === DIFF_INSERT) {
      added += countLines(text);
    } else if (type === DIFF_DELETE) {
      removed += countLines(text);
    }
  }

  return { added, removed };
}

/**
 * Compute the 0-based line number where the first change occurs.
 * Returns null if the content is identical.
 */
export function firstChangedLine(
  original: string,
  proposed: string,
): number | null {
  if (original === proposed) {
    return null;
  }

  const diffs = createSemanticDiffs(original, proposed);
  let proposedLine = 0;

  for (const [type, text] of diffs) {
    switch (type) {
      case DIFF_EQUAL:
        proposedLine += (text.match(/\n/g) ?? []).length;
        break;
      case DIFF_INSERT:
        return proposedLine;
      case DIFF_DELETE:
        return proposedLine;
    }
  }

  return 0;
}

export function computeUserPatch(
  suggestedContent: string,
  appliedContent: string,
): string | undefined {
  if (suggestedContent === appliedContent) {
    return undefined;
  }

  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(suggestedContent, appliedContent);

  if (patches.length === 0) {
    return undefined;
  }

  return dmp.patch_toText(patches);
}
