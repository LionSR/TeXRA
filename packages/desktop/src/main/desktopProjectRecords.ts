/** The desktop profile's ordered project selection, independent of project sessions. */
import { Effect } from 'effect';

import { aggregateId } from '@shared/schemas';
import { GlobalDatabase } from '@shared/session/database';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

/**
 * The remembered projects, on the process's handle on the global root.
 *
 * That root is the shared `~/.texra` this process already keeps its sessions,
 * inquiry threads and update check in, not the Electron profile directory
 * this list used to be written to: the same ruling that moved the
 * update-check row onto the one process handle moves this row with it, since
 * one handle per process is the point and a second root would mean a second
 * connection and a second change poll for one list. The move is a one-time
 * loss of the remembered list for an existing install — the first launch
 * after it shows no recent projects and the list fills again as projects are
 * opened. Nothing reads the old row: a reader for it would be exactly the
 * legacy-format path this repo does not keep.
 */
export const openDesktopProjectRecords = Effect.gen(function* () {
  const database = yield* GlobalDatabase;
  const id = aggregateId('desktop-projects', 'remembered');
  const lanes = new Map<string, PerKeyLane>();
  const read = Effect.gen(function* () {
    const latest = yield* database.readDesktopProjects(id);
    if (latest === undefined) return [] as string[];
    if (
      latest.type !== 'state.value.set' ||
      latest.state.key !== 'desktop-projects'
    ) {
      return yield* Effect.fail(new Error('Invalid desktop project record'));
    }
    return latest.state.roots;
  });
  const update = (change: (roots: readonly string[]) => readonly string[]) =>
    Effect.gen(function* () {
      const current = yield* read;
      const roots = change(current);
      if (
        roots.length === current.length &&
        roots.every((root, index) => root === current[index])
      )
        return;
      yield* database.appendAll([
        {
          type: 'state.value.set',
          aggregateId: id,
          state: { key: 'desktop-projects', roots: [...roots] },
        },
      ]);
    }).pipe(withPerKeyLane(lanes, 'remembered'));
  return {
    read,
    remember: (root: string) =>
      update((roots) => (roots.includes(root) ? roots : [...roots, root])),
    activate: (root: string) =>
      update((roots) => [...roots.filter((entry) => entry !== root), root]),
    forget: (root: string, activeRoot?: string) =>
      update((roots) => {
        const remaining = roots.filter((entry) => entry !== root);
        if (activeRoot === undefined) return remaining;
        return [
          ...remaining.filter((entry) => entry !== activeRoot),
          activeRoot,
        ];
      }),
    replace: (roots: readonly string[]) => update(() => roots),
  };
});

export type DesktopProjectRecords = Effect.Success<
  typeof openDesktopProjectRecords
>;
