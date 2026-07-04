import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_INSERT,
} from 'diff-match-patch';

import { countLines } from './stringUtils';

type Diff = ReturnType<InstanceType<typeof diff_match_patch>['diff_main']>[number];

/**
 * Tally added/removed line counts from a diff-match-patch diff list.
 * Shared by the tool-edit approval summary and the output diff-stats
 * computation, which both walk `diff_main` output the same way but apply
 * different preprocessing (semantic cleanup, base-file presence) beforehand.
 */
export function tallyDiffLineChanges(diffs: Diff[]): {
  added: number;
  removed: number;
} {
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
