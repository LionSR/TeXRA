/**
 * The unseen record every host's run list reads: a top-level run that
 * finished after the surface last showed it. The surface keeps, per
 * top-level run, the `lastTimestamp` it showed (`RunSurface.seen`); the view
 * says when the run last changed.
 */
import type { RunId, SessionView } from '@texra-ai/harness/schemas';

import { runSurface, shownRun, updateRun, type Surface } from './surface';

/** The surface with its shown top-level run recorded as seen as `view`
 *  states it; the same record when nothing moved. */
export function markShownRunSeen(surface: Surface, view: SessionView): Surface {
  const shown = shownRun(surface);
  const run = shown === null ? undefined : view.runs.get(shown);
  if (
    run === undefined ||
    run.parentId !== null ||
    (runSurface(surface, run.id).seen ?? -Infinity) >= run.lastTimestamp
  )
    return surface;
  return updateRun(surface, run.id, (record) => ({
    ...record,
    seen: run.lastTimestamp,
  }));
}

/**
 * The top-level runs that finished after this surface last showed them. A
 * run it never recorded was never shown here (it predates the record, or
 * another host launched it), so it is not news either.
 */
export function unseenRuns(
  surface: Surface,
  view: SessionView,
): ReadonlySet<RunId> {
  const unseen = new Set<RunId>();
  for (const run of view.runs.values()) {
    const { seen } = runSurface(surface, run.id);
    if (
      run.parentId === null &&
      run.outcome !== null &&
      seen !== undefined &&
      seen < run.lastTimestamp
    )
      unseen.add(run.id);
  }
  return unseen;
}
