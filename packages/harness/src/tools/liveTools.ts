/**
 * The tool catalog: every tool some plugin contributes, the services its
 * plugins' layers serve, and the MCP server processes it runs, each held
 * for exactly as long as something uses it.
 *
 * - **Built-in plugins** (the `ToolRegistry`'s) are on while their switch is
 *   (one with no switch always is); the switches reach the catalog as a
 *   stream. A plugin's `processLayer` is up, once per process, while it is
 *   on or a step uses it.
 * - **A session's catalog** (`session`, `@tools/sessionTools`: one per
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

import type { RunRegistry } from '@agent/runtime/runRegistry';
import { AppState } from '@platform/interfaces';
import type { PluginContext } from '@platform/processRuntime';
import { entriesOf, type ToolEntry } from '@tools/catalogEntries';
import type { Plugin } from '@tools/plugins';
import {
  buildPluginLayer,
  follow,
  NONE,
  sessionTools,
  type SessionTools,
  type ProcessCatalog,
} from '@tools/sessionTools';
import {
  ToolRegistry,
  type InstalledToolReader,
  type PluginLayerServices,
  type PluginLoader,
  type ToolTable,
} from '@tools/toolTable';

/** The process's tool catalog. */
export class ToolCatalog extends Context.Service<
  ToolCatalog,
  {
    /** The built-in plugins' tools as the switches stand: now, then on each
     *  change (what a host mirrors outside any run: Copilot's tools). */
    readonly current: Stream.Stream<ReadonlyMap<string, ToolEntry>>;
    /** Borrow a plugin's process services for the caller's scope without
     *  starting them; none while its layer is down. */
    readonly processServices: (
      plugin: string,
    ) => Effect.Effect<Option.Option<PluginContext>, never, Scope.Scope>;
    /** The shutdown protocol's plugin step: every up process layer's
     *  `drain`, while its services are still up. */
    readonly drain: Effect.Effect<void>;
    /** A session's catalog, in the caller's scope (the session's). */
    readonly session: (
      runs: () => RunRegistry,
    ) => Effect.Effect<SessionTools, never, Scope.Scope>;
  }
>()('@texra/tools/ToolCatalog') {}

/**
 * The catalog over `table`, served with it as the `ToolRegistry`: the
 * configured MCP servers `loader` reads for a run's declared tools, the
 * installed plugins `installed` reads at each step (none when omitted), and
 * the `switches` as they stand and on each change (the ids held off; before
 * the first, every switched plugin is off; omitted, none ever is).
 */
export const toolCatalogLayer = (
  table: ToolTable,
  options: {
    readonly loader?: PluginLoader;
    readonly installed?: InstalledToolReader;
    readonly switches?: Stream.Stream<ReadonlySet<string>>;
  } = {},
): Layer.Layer<
  ToolCatalog | ToolRegistry,
  never,
  Exclude<PluginLayerServices, ToolCatalog>
> => {
  const plugins = [...table.entries.values()];
  const layersOf = <L>(pick: (plugin: Plugin) => L | undefined) =>
    new Map(
      plugins.flatMap((plugin) => {
        const layer = pick(plugin);
        return layer === undefined ? [] : [[plugin.id, layer] as const];
      }),
    );
  const processLayerOf = layersOf((plugin) => plugin.processLayer?.layer);
  const drains = layersOf((plugin) => plugin.processLayer?.drain);
  // Only a probed plugin has a switch: a stored id of any other switches
  // nothing.
  const onOf = (off: ReadonlySet<string>): ReadonlySet<string> =>
    new Set(
      plugins
        .filter(({ id, availability }) => !off.has(id) || !availability)
        .map(({ id }) => id),
    );
  const catalog = Layer.effect(
    ToolCatalog,
    Effect.gen(function* () {
      // What a process layer is built over, beside this catalog: exactly
      // these services, never the build's scope with them.
      const process = Context.pick(
        FileSystem.FileSystem,
        Path.Path,
        ChildProcessSpawner,
        AppState,
      )(yield* Effect.context<Exclude<PluginLayerServices, ToolCatalog>>());
      const on = yield* SubscriptionRef.make(
        onOf(new Set(table.entries.keys())),
      );
      yield* Stream.runForEach(
        options.switches ?? Stream.succeed(new Set<string>()),
        (off) => SubscriptionRef.set(on, onOf(off)),
      ).pipe(Effect.forkScoped);
      // A process layer may read this catalog (Copilot's tools follow it).
      const processLayers: RcMap.RcMap<string, PluginContext> =
        yield* RcMap.make({
          lookup: (id: string) =>
            buildPluginLayer(id, processLayerOf).pipe(
              Effect.provideService(ToolCatalog, service),
              Effect.provide(process),
            ),
        });
      yield* follow(
        SubscriptionRef.changes(on),
        [...processLayerOf.keys()],
        (id) => RcMap.get(processLayers, id),
      );
      const shared: ProcessCatalog = {
        builtIn: plugins.map((plugin) => ({
          plugin,
          entries: entriesOf(
            plugin.id,
            new Map(Object.entries(plugin.tools ?? {})),
          ),
        })),
        onOf,
        on,
        processLayers,
        sessionLayerOf: layersOf((plugin) => plugin.sessionLayer),
        spawner: Context.get(process, ChildProcessSpawner),
        loader: options.loader ?? (() => NONE),
        installed: options.installed ?? NONE,
      };
      const processServices = (id: string) =>
        RcMap.getOption(processLayers, id);
      const service: ToolCatalog['Service'] = {
        current: SubscriptionRef.changes(on).pipe(
          Stream.map(
            (switchedOn): ReadonlyMap<string, ToolEntry> =>
              new Map(
                shared.builtIn.flatMap(({ plugin, entries }) =>
                  switchedOn.has(plugin.id) ? [...entries] : [],
                ),
              ),
          ),
        ),
        processServices,
        drain: Effect.forEach(
          drains,
          ([id, drain]) =>
            Effect.scoped(
              Effect.flatMap(processServices(id), (services) =>
                Option.isSome(services)
                  ? Effect.provide(drain, services.value)
                  : Effect.void,
              ),
            ),
          { concurrency: 'unbounded', discard: true },
        ),
        session: (runs) => sessionTools(shared, runs),
      };
      return service;
    }),
  );
  return catalog.pipe(Layer.provideMerge(Layer.succeed(ToolRegistry)(table)));
};
