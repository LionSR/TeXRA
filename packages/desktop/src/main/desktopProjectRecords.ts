/** The desktop profile's ordered project selection, independent of project sessions. */
import { Context, Effect, Layer } from 'effect';

import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { aggregateId, type OwnerId } from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

/** Acquire the profile database in the caller's desktop process scope. */
export const openDesktopProjectRecords = (
  userDataPath: string,
  ownerId: OwnerId,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      databaseLayer('persistent').pipe(
        Layer.provide(
          Layer.succeed(WorkspaceRoots)({
            storage: resolveGlobalStoragePath(userDataPath),
          }),
        ),
        Layer.provide(ProcessIdentity.layer(ownerId)),
      ),
    );
    const database = Context.get(context, Database);
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
      forget: (root: string) =>
        update((roots) => roots.filter((entry) => entry !== root)),
      replace: (roots: readonly string[]) => update(() => roots),
    };
  });

export type DesktopProjectRecords = Effect.Success<
  ReturnType<typeof openDesktopProjectRecords>
>;
