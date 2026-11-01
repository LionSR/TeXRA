/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `processLayer()`. Formerly one file per port under `interfaces/`.
 */
import { Context, Effect, FileSystem, Layer, Schema, Stream } from 'effect';
import { AgentSourceSchema } from '@shared/schemas';
import type { StateReadFailed, StateStore } from '@shared/config/settings';

import type { GlobalStorageFs } from './rootedFs';

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

/** The global state store, and what changes in it. */
export interface AppStateStore extends StateStore {
  /**
   * Emits as subscribed, then whenever one of `keys` may have been written,
   * by this process or by another sharing the store: a reader re-reads the
   * keys on each. A store with no change feed emits only the first.
   */
  changes(keys: readonly string[]): Stream.Stream<void>;
}

/**
 * Global application state, provided by the process's composition layer.
 * SQLite hosts acquire their store in the runtime's scope over the global
 * database, whose change feed reaches every process sharing it. `layer`
 * serves a store a caller supplies, which has none: a reader of it sees a
 * change at its next read.
 */
export class AppState extends Context.Service<AppState, AppStateStore>()(
  '@texra-ai/harness/platform/AppState',
) {
  static layer(store: StateStore): Layer.Layer<AppState> {
    return Layer.succeed(AppState)({
      get: (key) => store.get(key),
      update: (key, value) => store.update(key, value),
      modify: (key, change) => store.modify(key, change),
      changes: () => Stream.succeed(undefined),
    });
  }
}

// ---------------------------------------------------------------------------
// Agent directories
// ---------------------------------------------------------------------------

/**
 * A host could not resolve one of its agent directories: the configured
 * custom directory is not an absolute path, its parent is gone, it cannot be
 * created, or the platform refused the filesystem call behind either.
 *
 * {@link AgentDirectoriesPort}'s readers raise it as the failure of the
 * read itself, for the same reason `StateWriteFailed` exists: the reads
 * travel with the agent-catalog load beside them, so a caller inside a program
 * composes the read rather than adopting a rejection it cannot type.
 */
export class AgentDirectoriesFailed extends Schema.TaggedError<AgentDirectoriesFailed>()(
  'AgentDirectoriesFailed',
  {
    /** Which of the port's readers failed. */
    source: AgentSourceSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Host-provided agent directory paths. All are `Effect`s (not Promises)
 * so the readers that can fault — `custom`, which creates the directory it
 * resolves, and `customConfigured`, which validates the setting — carry their
 * failure into the program that asked instead of rejecting an await that
 * cannot name it.
 *
 * `custom` takes the process's {@link GlobalStorageFs} and the process
 * `FileSystem` from context: the default custom-agents directory lives under
 * the cross-workspace storage root, and a configured one is an absolute path
 * outside every root, so the view that names each is the one the process
 * runtime provides.
 */
export interface AgentDirectoriesPort {
  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  /** Whether `custom` resolves to a directory the user configured, rather
   *  than falling back to the default one under global storage. */
  customConfigured(): Effect.Effect<
    boolean,
    AgentDirectoriesFailed,
    FileSystem.FileSystem
  >;
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed>;
  /**
   * The member names of the workspace's team `teamId`, read from its
   * repository state; `undefined` for a team the workspace has none of. The
   * app owns what a team is; the harness only stores a selection naming one
   * by id. Absent, the app has no teams.
   */
  readonly teamMembers?: (
    repoState: StateStore,
    teamId: string,
  ) => Effect.Effect<readonly string[] | undefined, StateReadFailed>;
  /**
   * The packaged resources root a host ships its bundled agents under,
   * the tool plugins' agent directories among them. Absent where none ships:
   * an embedder's own directories, or the CLI entries that load no agents.
   */
  readonly resourcesRoot?: string;
}

/**
 * The process's agent directories as an Effect service, provided once by the
 * composition root through `processLayer`. The shape is the port itself: a
 * program that resolves one of the three local agent directories yields the
 * port's own readers instead of reaching for the process platform's copy.
 * A root holds its port before it installs the runtime that serves it, so the
 * layer is `Layer.succeed(AgentDirectories)(port)`.
 */
export class AgentDirectories extends Context.Service<
  AgentDirectories,
  AgentDirectoriesPort
>()('@texra-ai/harness/platform/AgentDirectories') {}
