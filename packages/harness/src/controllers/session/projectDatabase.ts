/** One persistent connection per project root, shared by its scoped borrowers. */
import { Context, Effect, Layer, RcMap } from 'effect';

import { Database, ProjectDatabases } from '@shared/session/database';

import { databaseLayer } from './Database';
import { WorkspaceRoots } from './WorkspaceRoots';

/** No idle retention or explicit invalidation: the project owns its state
 *  borrow and the session graph owns its borrow until their scopes unwind. */
export const projectDatabaseLayer = Layer.effect(
  ProjectDatabases,
  RcMap.make({
    lookup: (storage: string) =>
      Layer.build(
        databaseLayer('persistent').pipe(
          Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
        ),
      ).pipe(Effect.map((context) => Context.get(context, Database))),
  }),
);
