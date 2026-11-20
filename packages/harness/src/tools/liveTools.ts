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
import type { Plugin } from '@tools/plugins';
import {
  buildPluginLayer,
  follow,
  heldKeys,
  layerKey,
  NONE,
  sessionTools,
  type SessionTools,
  type ProcessCatalog,
} from '@tools/sessionTools';
import {
  ToolRegistry,
  withNatives,
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
 * a native plugin enabled or disabled anywhere comes up or goes down then),
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
      // Every native revision this process loaded, by layer key: a step
      // that pinned one builds its layers from here after the table moved
      // on, as the module itself stays loaded.
      const natives = new Map<string, Plugin>();
      const pluginOf = (key: string) =>
        table.entries.get(key) ?? natives.get(key);
      const live = yield* SubscriptionRef.make(table);
      // The native revisions a table holds, one key each: a read that
      // loads what the last one did publishes nothing.
      const revisions = (of: ToolTable) =>
        [...of.entries.keys()]
          .map((id) => layerKey(id, of.revisionOf(id)))
          .join('\0');
      const read = Effect.gen(function* () {
        const found = yield* installed;
        const loaded = found.plugins.flatMap(({ native }) => native ?? []);
        for (const { plugin, revision } of loaded)
          natives.set(layerKey(plugin.id, revision), plugin);
        const composed = withNatives(table, loaded);
        if (
          revisions(composed.table) !==
          revisions(yield* SubscriptionRef.get(live))
        )
          yield* SubscriptionRef.set(live, composed.table);
        return {
          installed: found,
          table: composed.table,
          warnings: [...found.warnings, ...composed.withheld],
        };
      });
      yield* Stream.runForEach(
        options.installedChanges ?? Stream.empty,
        () => read,
      ).pipe(Effect.forkScoped);
      // A process layer may read this catalog.
      const processLayers: RcMap.RcMap<string, PluginContext> =
        yield* RcMap.make({
          lookup: (key: string) =>
            buildPluginLayer(key, pluginOf(key)?.processLayer?.layer).pipe(
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
        pluginOf,
        processLayers,
        spawner: Context.get(process, ChildProcessSpawner),
        loader: options.loader ?? (() => NONE),
      };
      yield* follow(
        heldKeys(shared, ({ processLayer }) => processLayer),
        (key) => RcMap.get(processLayers, key),
      );
      const processServices = (id: string) =>
        Effect.flatMap(SubscriptionRef.get(live), (now) =>
          RcMap.getOption(processLayers, layerKey(id, now.revisionOf(id))),
        );
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
              const drain = pluginOf(key)?.processLayer?.drain;
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
