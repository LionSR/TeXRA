/**
 * The unseen record every host's run list reads: a top-level run that
 * finished after the surface last showed it. The surface keeps, per
 * top-level run, the `lastTimestamp` it showed (`Surface.seen`); the fold
 * says when the run last changed.
 */
import type { RunId } from '@shared/schemas';

import type { SessionView } from './sessionView';
import type { Surface } from './surface';

/** The surface with its shown top-level run recorded as seen as `view`
 *  states it; the same record when nothing moved. */
export function markShownRunSeen(surface: Surface, view: SessionView): Surface {
  const run =
    surface.selected === null ? undefined : view.runs.get(surface.selected);
  if (
    run === undefined ||
    run.parentId !== null ||
    run.lastTimestamp === null ||
    surface.seen.get(run.id) === run.lastTimestamp
  )
    return surface;
  return {
    ...surface,
    seen: new Map(surface.seen).set(run.id, run.lastTimestamp),
  };
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
    const seen = surface.seen.get(run.id);
    if (
      run.parentId === null &&
      run.durableOutcome !== null &&
      seen !== undefined &&
      run.lastTimestamp !== null &&
      seen < run.lastTimestamp
    )
      unseen.add(run.id);
  }
  return unseen;
}
