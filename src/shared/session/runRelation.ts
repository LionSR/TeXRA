/**
 * The one reading of where two runs stand in the supervision tree, for
 * every surface that says it: admission stamping a message's sender, the
 * `/executions` listing, the CLI's `/ps`. Parentage is the view's
 * `parentId`, so a detached run is top level here as everywhere else.
 */
import type { RunId, RunRelation } from '@shared/schemas';

type ParentOf = (runId: RunId) => RunId | null | undefined;

/** `runId`'s ancestors, nearest first. Parentage is a tree by construction;
 *  the visited check only keeps a corrupt cycle from spinning. */
function ancestry(runId: RunId, parentOf: ParentOf): RunId[] {
  const line: RunId[] = [];
  for (let up = parentOf(runId); up != null; up = parentOf(up)) {
    if (line.includes(up)) break;
    line.push(up);
  }
  return line;
}

/** What run `a` is to run `b`. */
export function runRelation(
  a: RunId,
  b: RunId,
  parentOf: ParentOf,
): RunRelation {
  const aLine = ancestry(a, parentOf);
  const bLine = ancestry(b, parentOf);
  if (bLine[0] === a) return 'parent';
  if (aLine[0] === b) return 'child';
  if (bLine.includes(a)) return 'ancestor';
  if (aLine.includes(b)) return 'descendant';
  if (aLine[0] !== undefined && aLine[0] === bLine[0]) return 'sibling';
  return 'peer';
}
