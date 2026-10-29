/** The application-state stores beyond the current workspace's `AppState`,
 *  both served over the process's databases by `processStoresLayer`. */
import { Context, type Effect, type Scope } from 'effect';
import type {
  CurrentValues,
  DatabaseOpenFailed,
} from '@shared/session/database';

import type { AppStateStore } from './interfaces';

/**
 * The global root's current values: one row per family and key, replaced in
 * place by each write. A host or plugin keeps its own application state here
 * under a family it declares (`ValueFamily`).
 */
export class GlobalValues extends Context.Service<
  GlobalValues,
  CurrentValues
>()('@texra-ai/harness/GlobalValues') {}

/** The settings stores a host opens for each project it shows. */
export class StateStores extends Context.Service<
  StateStores,
  {
    /** The project's own settings, in its store at `storage`, held for the
     *  caller's scope; it records which root the store serves. */
    readonly project: (
      storage: string,
      workspaceRoot: string | undefined,
    ) => Effect.Effect<AppStateStore, DatabaseOpenFailed, Scope.Scope>;
    /** The settings every checkout of `workspaceRoot`'s repository shares. */
    readonly repo: (
      storage: string,
      workspaceRoot: string | undefined,
    ) => Effect.Effect<AppStateStore>;
  }
>()('@texra-ai/harness/StateStores') {}
