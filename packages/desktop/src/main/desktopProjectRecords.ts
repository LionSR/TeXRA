/** The desktop profile's ordered project selection, independent of project sessions. */
import { Effect } from 'effect';

import { aggregateId } from '@shared/schemas';
import { GlobalDatabase } from '@shared/session/database';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

/** The remembered projects, on the process's handle on the global root. */
export const openDesktopProjectRecords = Effect.gen(function* () {
  const database = yield* GlobalDatabase;
  const id = aggregateId('desktop-projects', 'remembered');
  const lanes = new Map<string, PerKeyLane>();
  const read = Effect.gen(function* () {
    const latest = yield* database.readDesktopProjects(id);
    if (latest === undefined) return [] as string[];
    if (latest.type !== 'desktop.projects.changed') {
      return yield* Effect.fail(new Error('Invalid desktop project record'));
    }
    return latest.roots;
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
          type: 'desktop.projects.changed',
          aggregateId: id,
          roots: [...roots],
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
