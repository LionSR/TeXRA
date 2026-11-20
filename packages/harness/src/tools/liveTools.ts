/**
 * The tool catalog: every tool some plugin contributes, the services its
 * plugins' layers serve, and the MCP server processes it runs, each held
 * for exactly as long as something uses it.
 *
 * - **Built-in plugins** (the listed `ToolTable`'s) are on while their
 *   switch is (one with no switch always is); the switches reach the
 *   catalog as a stream. A plugin's `processLayer` is up, once per process,
 *   while it is on or a step uses it.
 * - **Native plugins** (an installed plugin's `harness.mjs`) are on while
 *   the installed plugin loads; each read of the installed plugins (every
 *   step's, and every run's launch) publishes the table they make with the
 *   listed ones (`live`), the one owner of which plugins there are now. A
 *   native plugin's layers are kept per revision: a replaced one's new
 *   layer comes up beside the old, which goes down when the last step that
 *   pinned it ends.
 * - **A session's catalog** (`session`, built by `sessionTools`: one per
 *   project, in that session's scope) owns the project's plugin layers and
 *   MCP servers, and pins each step's tools, the only place a run's tools
 *   change.
 *
 * Every resource is an entry of an `RcMap` in its lifetime's scope.
 */
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  RcMap,
  Result,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';

import { withLogChannel } from '@logger/effectLog';
import { AppSignals } from '@platform/appSignals';
import { AppState } from '@platform/interfaces';
import type { PluginContext } from '@platform/processRuntime';
import type {
  StateReadFailed,
  StateWriteFailed,
} from '@shared/config/settings';
import { entriesOf } from '@tools/catalogEntries';
import {
  buildPluginLayer,
  follow,
  heldKeys,
  LayerKey,
  NONE,
  sessionTools,
  type SessionTools,
  type ProcessCatalog,
} from '@tools/sessionTools';
import {
  nativeLoader,
  notLoaded,
  type NativePluginFailed,
} from '@tools/nativePlugins';
import {
  ToolRegistry,
  withNatives,
  type NativePlugin,
  type PluginLayerServices,
  type ToolTable,
} from '@tools/toolTable';
import type { InstalledToolReader, PluginLoader } from '@tools/mcp/mcpConfig';
import { readDisabledTools, setToolEnabled } from '@shared/state/disabledTools';

/** The process's tool catalog's identifier: what a program that reads the
 *  catalog requires. */
export interface ToolCatalog {
  readonly _: unique symbol;
}

/** The process's tool catalog as a host, or a plugin's process layer,
 *  reads it. */
export interface ToolCatalogShape {
  /** Borrow a plugin's process services (a native plugin's at the revision
   *  loaded now) for the caller's scope without starting them; none while
   *  its layer is down. */
  readonly processServices: (
    plugin: string,
  ) => Effect.Effect<Option.Option<PluginContext>, never, Scope.Scope>;
  /** Switch a plugin that has a switch (`toggle`) on or off in the global
   *  state store, which every process follows (`AppState.changes`); any
   *  other id is refused loudly, and an invalid record refuses the write. */
  readonly setEnabled: (
    plugin: string,
    enabled: boolean,
  ) => Effect.Effect<void, StateReadFailed | StateWriteFailed>;
  /** The plugin ids switched off in the global state store now; none while
   *  no switch was written. */
  readonly disabled: Effect.Effect<ReadonlySet<string>, StateReadFailed>;
}

/** The process's tool catalog. */
export const ToolCatalog = Context.Service<ToolCatalog, ToolCatalogShape>(
  '@texra-ai/harness/tools/ToolCatalog',
);

/** The owner's catalog's identifier: what the process's owner requires. */
export interface ToolCatalogOwner {
  readonly _: unique symbol;
}

/** The catalog the process's owner runs on: the host's reads, with the
 *  shutdown protocol's plugin step and each session's catalog.
 *  `toolCatalogLayer` serves one object under both keys. */
export const ToolCatalogOwner = Context.Service<
  ToolCatalogOwner,
  ToolCatalogShape & {
    /** The shutdown protocol's plugin step: the `drain` of every process
     *  layer up, each revision of a native plugin's among them, while its
     *  services are still up. */
    readonly drain: Effect.Effect<void>;
    /** A session's catalog, in the caller's scope (the session's). */
    readonly session: Effect.Effect<
      SessionTools,
      never,
      Scope.Scope | SubscriptionAccounts
    >;
  }
>('@texra-ai/harness/tools/ToolCatalogOwner');

/**
 * The catalog over `table`, the listed plugins', served with it as the
 * `ToolRegistry` a reader outside any run reads: the configured MCP servers
 * `loader` reads for a run's declared tools, the installed plugins and
 * their native plugins `installed` reads at each step (none when omitted),
 * read again at each of `installedChanges` (the install record changed, so
 * a native plugin disabled or replaced anywhere goes down then; one enabled
 * is imported when a step or a launch next reads, never by this read),
 * and the `switches` as they stand and on each change (the ids held off;
 * before the first, every switched plugin is off; omitted, none ever is).
 */
export const toolCatalogLayer = (
  table: ToolTable,
  options: {
    readonly loader?: PluginLoader;
    readonly installed?: InstalledToolReader;
    readonly installedChanges?: Stream.Stream<unknown>;
    readonly switches?: Stream.Stream<ReadonlySet<string>>;
  } = {},
): Layer.Layer<
  ToolCatalog | ToolCatalogOwner | ToolRegistry,
  never,
  Exclude<PluginLayerServices, ToolCatalog>
> => {
  const plugins = [...table.entries.values()];
  const installed = options.installed ?? NONE;
  // Only a plugin with a switch (`toggle`, the one the dashboard and the
  // CLI show) is switched: a stored id of any other switches nothing.
  const onOf = (off: ReadonlySet<string>): ReadonlySet<string> =>
    new Set(
      plugins
        .filter(({ id, toggle }) => toggle === undefined || !off.has(id))
        .map(({ id }) => id),
    );
  const catalog = Layer.effectContext(
    Effect.gen(function* () {
      // What a process layer is built over, beside this catalog: exactly
      // these services, never the build's scope with them.
      const process = Context.pick(
        FileSystem.FileSystem,
        Path.Path,
        ChildProcessSpawner,
        AppState,
        AppSignals,
      )(yield* Effect.context<Exclude<PluginLayerServices, ToolCatalog>>());
      const on = yield* SubscriptionRef.make(
        onOf(new Set(table.entries.keys())),
      );
      yield* Stream.runForEach(
        options.switches ?? Stream.succeed(new Set<string>()),
        (off) => SubscriptionRef.set(on, onOf(off)),
      ).pipe(Effect.forkScoped);
      const live = yield* SubscriptionRef.make(table);
      // The native revisions a table holds, one key each: a read that
      // loads what the last one did publishes nothing.
      const revisions = (of: ToolTable) =>
        of.natives
          .map(({ plugin, revision }) => new LayerKey(plugin, revision).name)
          .join('\0');
      const loader = yield* nativeLoader;
      // Each native plugin's revision the table held before the one it
      // holds now, while its installed plugin stays enabled: kept in memory
      // only, for when the one in use stops loading. A disabled or removed
      // plugin forgets it.
      const previous = new Map<string, NativePlugin>();
      // The installed plugins as read now and the table they make, with
      // each native entry imported now (`load`), or only those a step or a
      // launch already imported: a change to the install record takes a
      // disabled or replaced plugin out at once, and runs no plugin's code;
      // a plugin trusted at a revision not imported yet keeps the one in use
      // until a step tries the new one.
      const readWith = (load: boolean) =>
        Effect.gen(function* () {
          const found = yield* installed;
          for (const id of previous.keys())
            if (!found.enabled.has(id)) previous.delete(id);
          const inUse = new Map(
            (yield* SubscriptionRef.get(live)).natives.map((native) => [
              native.plugin.id,
              native,
            ]),
          );
          // A revision of `id` that does not load (its import, its value,
          // its layers or the table refused it) keeps the revision in use,
          // else the one before it, unless that is the revision refused or
          // its layers did not come up either; with none, the plugin is
          // withheld. The step says which.
          const standInFor = (id: string, revision?: string) =>
            [inUse.get(id), previous.get(id)].find(
              (native): native is NativePlugin =>
                native !== undefined &&
                native.revision !== revision &&
                !loader.rejected(native),
            );
          const notes: string[] = [];
          const say = (failed: NativePluginFailed, stand?: NativePlugin) =>
            notes.push(
              stand === undefined
                ? failed.message
                : `${failed.message}; revision ${stand.revision.slice(0, 12)} stays in use until the plugin is fixed or disabled.`,
            );
          const fresh = new Set<NativePlugin>();
          const candidates = (yield* Effect.forEach(
            found.plugins,
            ({ id, source }) =>
              Effect.gen(function* () {
                if (source.plugin.native === null) return undefined;
                if (!load && Option.isNone(yield* loader.imported(source)))
                  return inUse.get(id);
                const result = yield* Effect.result(loader.load(source));
                if (Result.isSuccess(result)) {
                  fresh.add(result.success);
                  return result.success;
                }
                const stand = standInFor(id);
                say(result.failure, stand);
                return stand;
              }),
            { concurrency: 'unbounded' },
          )).filter((native) => native !== undefined);
          // A new revision the table refuses leaves the one before it in
          // use, judged again with the rest.
          const first = withNatives(table, candidates);
          const replaced = new Map(
            first.withheld.flatMap(({ native, reason }) => {
              const { plugin, revision } = native;
              const stand = fresh.has(native)
                ? standInFor(plugin.id, revision)
                : undefined;
              if (stand === undefined) return [];
              say(notLoaded(plugin.id, revision, reason), stand);
              return [[native, stand]];
            }),
          );
          const composed =
            replaced.size === 0
              ? first
              : withNatives(
                  table,
                  candidates.map((native) => replaced.get(native) ?? native),
                );
          for (const { native, reason } of composed.withheld)
            say(notLoaded(native.plugin.id, native.revision, reason));
          for (const native of composed.table.natives) {
            const held = inUse.get(native.plugin.id);
            if (held !== undefined && held.revision !== native.revision)
              previous.set(native.plugin.id, held);
          }
          if (
            revisions(composed.table) !==
            revisions(yield* SubscriptionRef.get(live))
          )
            yield* SubscriptionRef.set(live, composed.table);
          return {
            installed: found,
            table: composed.table,
            warnings: [...found.warnings, ...notes],
          };
        });
      const read = readWith(true);
      yield* Stream.runForEach(options.installedChanges ?? Stream.empty, () =>
        readWith(false),
      ).pipe(Effect.forkScoped);
      // A process layer may read this catalog.
      const processLayers: RcMap.RcMap<LayerKey, PluginContext> =
        yield* RcMap.make({
          lookup: (key: LayerKey) =>
            buildPluginLayer(key, key.plugin.processLayer?.layer).pipe(
              Effect.provideContext(served),
              Effect.provide(process),
            ),
        });
      const shared: ProcessCatalog = {
        listed: table,
        builtIn: plugins.map((plugin) => ({
          plugin,
          entries: entriesOf(plugin.id, plugin.tools ?? []),
        })),
        onOf,
        on,
        live,
        read,
        layerFailed: loader.reject,
        processLayers,
        spawner: Context.get(process, ChildProcessSpawner),
        loader: options.loader ?? (() => NONE),
      };
      yield* follow(
        heldKeys(shared, ({ processLayer }) => processLayer),
        (key) => RcMap.get(processLayers, key),
      );
      const processServices = (id: string) =>
        Effect.flatMap(SubscriptionRef.get(live), (now) => {
          const plugin = now.entries.get(id);
          return plugin === undefined
            ? Effect.succeedNone
            : RcMap.getOption(
                processLayers,
                new LayerKey(plugin, now.revisionOf(id)),
              );
        });
      const state = Context.get(process, AppState);
      const service: typeof ToolCatalogOwner.Service = {
        processServices,
        disabled: readDisabledTools(state),
        setEnabled: (id, enabled) =>
          (table.entries.get(id)?.toggle === undefined
            ? Effect.logWarning(`Plugin ${id} has no switch; nothing written.`)
            : setToolEnabled(state, id, enabled)
          ).pipe(withLogChannel('toolAvailability')),
        drain: Effect.flatMap(RcMap.keys(processLayers), (keys) =>
          Effect.forEach(
            keys,
            (key) => {
              const drain = key.plugin.processLayer?.drain;
              return drain === undefined
                ? Effect.void
                : Effect.scoped(
                    Effect.flatMap(
                      RcMap.getOption(processLayers, key),
                      (services) =>
                        Option.isSome(services)
                          ? Effect.provide(drain, services.value)
                          : Effect.void,
                    ),
                  );
            },
            { concurrency: 'unbounded', discard: true },
          ),
        ),
        session: sessionTools(shared),
      };
      // One object under both keys; a host reads the narrow one.
      const served = Context.make(ToolCatalogOwner, service).pipe(
        Context.add(ToolCatalog, service),
      );
      return served;
    }),
  );
  return catalog.pipe(Layer.provideMerge(Layer.succeed(ToolRegistry)(table)));
};
