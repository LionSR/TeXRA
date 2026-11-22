/**
 * Platform port contracts — the host-neutral interfaces a host wires into
 * `processLayer()`.
 */
import { Context, Layer, Stream } from 'effect';
import type { StateStore } from '@shared/config/settings';

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
      modify: (keys, change) => store.modify(keys, change),
      changes: () => Stream.succeed(undefined),
    });
  }
}

// ---------------------------------------------------------------------------
// Host resources
// ---------------------------------------------------------------------------

/**
 * What the host ships beside its code, as an Effect service the composition
 * root provides once through `processLayer`.
 */
export class HostResources extends Context.Service<
  HostResources,
  {
    /** The packaged resources root (templates, bundled plugin files).
     *  Absent where none ships: an embedder with no resources. */
    readonly resourcesRoot?: string;
  }
>()('@texra-ai/harness/platform/HostResources') {}
