/**
 * The process's live tool catalog: a `Registry` (`@tools/liveRegistry`) of
 * every tool some plugin contributes, by tool name.
 *
 * - **Built-in plugins** contribute their tools while their switch is on.
 *   `pinSwitched` reads the switches, reconciles the contributions with them
 *   and pins the generation that produces, with the plugins it leaves on
 *   (whose continuation and prompt section the step reads off their value),
 *   as one serialized step. A run's step opens through it
 *   (`@agent/runtime/loop/step`), so a switch flipped by any host, or by
 *   `texra tools` from another shell, reaches every open run at its next step.
 * - **Loaded plugins** (MCP servers, `@tools/toolTable`) contribute the tools
 *   their server listed while some run holds them (`hold`), counted per spec
 *   and keyed env revision: runs naming the same server share one process,
 *   which stops with the last hold, and an edited server's new process
 *   supersedes the older one and records a new revision.
 * - **Installed plugins** (enabled and trusted Claude Code and Codex plugins)
 *   contribute their MCP servers' tools under their one id, read at each
 *   run's step (`pinSwitched` with `installed`): a disabled or changed one is
 *   withdrawn there, or as soon as the record changes (`'withdraw'`, which
 *   the process's switch follower applies), and the generations that pinned
 *   it drain as usual.
 * - **Plugin layers** (each plugin's `processLayer`) are up while their plugin is
 *   on or a pinned generation holds it (`@tools/pluginLayers` builds a
 *   session's `sessionLayer`s by the same rule).
 *
 * Each entry carries its identity (the digest of its name and input schema,
 * its plugin's id and revision), which a call is checked against.
 */
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  RcMap,
  Scope,
  Semaphore,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { AppState } from '@platform/interfaces';
import type { PluginContext } from '@platform/processRuntime';
import { makeRegistry, type Pinned, type Registry } from '@tools/liveRegistry';
import type { Plugin } from '@tools/plugins';
import {
  ToolRegistry,
  type InstalledToolReader,
  type PluginLayerServices,
  type PluginLoader,
  type ToolTable,
} from '@tools/toolTable';
import {
  entriesOf,
  type HeldPlugins,
  type ToolEntry,
} from '@tools/catalogEntries';
import { makeServerHolds, type InstalledLoad } from '@tools/serverHolds';
import { buildPluginLayer } from '@tools/pluginLayers';

/** The services a pin serves: its plugins' layers'. */
type Services = PluginContext;

export class LiveTools extends Context.Service<
  LiveTools,
  {
    readonly registry: Registry<string, ToolEntry, void>;
    /** Read the switches (the ids the user holds off; only a probed plugin's
     *  switch counts), contribute exactly the built-in plugins they leave on,
     *  and pin the tool generation that produces and those plugins, as one
     *  serialized step: a concurrent step's older read never reverts the
     *  catalog under it, and no step pins a generation built from switches it
     *  did not read. */
    readonly pinSwitched: <E>(
      off: Effect.Effect<ReadonlySet<string>, E>,
      /** Also read the installed plugins: `true` loads them as they stand (a
       *  run's step); `'withdraw'` only withdraws those disabled, removed or
       *  changed since they loaded, starting nothing (a switch follower). */
      options?: { readonly installed: true | 'withdraw' },
    ) => Effect.Effect<
      Pinned<string, ToolEntry, void> & {
        /** Pin the process services of the plugins the step uses, from the
         *  plugins on when it pinned, for the caller's scope. */
        readonly layersFor: (
          plugins: ReadonlySet<string>,
        ) => Effect.Effect<Services, never, Scope.Scope>;
        /** The built-in plugins on when it pinned. */
        readonly plugins: readonly Plugin[];
        /** Why each enabled installed plugin, or one of its servers, offers
         *  no tools; empty unless the installed plugins were loaded. */
        readonly warnings: readonly string[];
        /** The installed plugins the catalog has accepted, by id, as read
         *  when accepted, those that ship only skills included: the source
         *  of the step's installed skills. Empty unless the installed
         *  plugins were loaded. */
        readonly installed: ReadonlyMap<string, LoadablePlugin>;
      },
      E,
      Scope.Scope
    >;
    /** Borrow an existing plugin layer for the caller's scope without
     *  starting one. A switched-off layer remains available while held; none
     *  once its last holder releases it or the catalog closes. */
    readonly processServices: (
      plugin: string,
    ) => Effect.Effect<Option.Option<Services>, never, Scope.Scope>;
    /** Hold the loaded plugins `declared` names until the caller's scope
     *  closes; their tools are in the catalog while held. */
    readonly hold: (
      declared: readonly string[],
    ) => Effect.Effect<HeldPlugins, never, Scope.Scope>;
  }
>()('@texra/tools/LiveTools') {}

const liveToolsLayer = (
  loader: PluginLoader,
  closed: ReadonlySet<string>,
  installedReader: InstalledToolReader,
): Layer.Layer<
  LiveTools,
  never,
  ToolRegistry | Exclude<PluginLayerServices, LiveTools>
> =>
  Layer.effect(
    LiveTools,
    Effect.gen(function* () {
      const table: ToolTable = yield* ToolRegistry;
      const spawner = yield* ChildProcessSpawner;
      // What a plugin's process layer is built over, beside this catalog:
      // exactly these services, never the build's scope with them.
      const process = Context.pick(
        FileSystem.FileSystem,
        Path.Path,
        ChildProcessSpawner,
        AppState,
      )(yield* Effect.context<Exclude<PluginLayerServices, LiveTools>>());
      const scope = yield* Effect.scope;
      // Each plugin's process layer, in its map entry's scope: its switch and
      // each generation that includes it hold a reference. It may read this
      // catalog (Copilot's tools follow it), built by then.
      const layers = yield* RcMap.make({
        lookup: (id: string) =>
          buildPluginLayer(id, table.entries.get(id)!.processLayer!.layer).pipe(
            Effect.provideService(LiveTools, service),
            Effect.provide(process),
          ),
      });
      // Each built-in plugin's open contribution, closed when switched off,
      // and each installed plugin's load, by id.
      const builtIns = new Map<string, Scope.Closeable>();
      const installed = new Map<string, InstalledLoad>();
      // Each step's read of the installed plugins is numbered as it begins,
      // and only a read newer than the last one applied decides what is
      // wanted (each plugin's key): a slow load from an older read never
      // reverts a newer one, and is still adopted when the newer read wants
      // what it loaded (a switch follower's read, which loads nothing).
      let reads = 0;
      let applied = 0;
      let wanted: ReadonlyMap<string, string> = new Map();
      // The catalog's lock: what runs under it is short and uninterruptible,
      // so a cancelled step never leaves a scope and its map out of step.
      const lock = yield* Semaphore.make(1);
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lock.withPermits(1)(Effect.uninterruptible(effect));
      const holds = makeServerHolds({
        scope,
        spawner,
        locked,
        registry: () => registry,
      });
      const registry = yield* makeRegistry<string, ToolEntry, void>({
        // The server processes the generation dispatches through.
        acquire: holds.pinHolds,
      });

      /** Open and close the built-in contributions (a plugin's tools and
       *  process layer, in one scope) to match `off`. */
      const reconcile = (off: ReadonlySet<string>) =>
        Effect.gen(function* () {
          for (const [id, plugin] of table.entries) {
            // Only a probed plugin has a switch: a stored id of any other
            // plugin switches nothing.
            const on = !off.has(id) || plugin.availability === undefined;
            const held = builtIns.get(id);
            if (on && held === undefined) {
              const contribution = yield* Scope.fork(scope);
              // The table rules out a name two plugins share, so a
              // conflict between built-in plugins is a defect.
              yield* registry
                .contribute(
                  id,
                  entriesOf(id, new Map(Object.entries(plugin.tools ?? {}))),
                )
                .pipe(
                  Effect.orDie,
                  // The switch's own hold on the plugin's process services.
                  Effect.andThen(
                    plugin.processLayer === undefined
                      ? Effect.void
                      : RcMap.get(layers, id),
                  ),
                  Scope.provide(contribution),
                  Effect.onError(() => Scope.close(contribution, Exit.void)),
                );
              builtIns.set(id, contribution);
            } else if (!on && held !== undefined) {
              builtIns.delete(id);
              yield* Scope.close(held, Exit.void);
            }
          }
        });
      const pinSwitched = <E>(
        off: Effect.Effect<ReadonlySet<string>, E>,
        options?: { readonly installed: true | 'withdraw' },
      ) =>
        Effect.gen(function* () {
          const loading = options?.installed === true;
          // A withdrawal reads only when something is loaded or a step's
          // read is in flight, which its newer read then supersedes.
          const reading =
            loading ||
            (options?.installed === 'withdraw' &&
              (installed.size > 0 || reads > applied));
          // Read, and the servers of a plugin that changed started, outside
          // the lock: a slow server does not hold up every run's step.
          const readId = reading ? ++reads : 0;
          const read = reading
            ? yield* installedReader
            : { plugins: [], warnings: [] };
          // Loads prepared here and not yet adopted by the catalog: none is
          // in a generation, and an interruption or failure before adoption
          // drops them.
          const started: InstalledLoad[] = [];
          const adopted = new Set<InstalledLoad>();
          const dropUnadopted = Effect.suspend(() =>
            Effect.forEach(
              started.filter((load) => !adopted.has(load)),
              (load) =>
                Effect.andThen(
                  Scope.close(load.contribution, Exit.void),
                  Scope.close(load.holds, Exit.void),
                ),
              { discard: true },
            ),
          );
          const retired: Scope.Closeable[] = [];
          const retire = (load: InstalledLoad) => {
            adopted.add(load);
            retired.push(load.holds);
            return Scope.close(load.contribution, Exit.void);
          };
          const pinned = yield* Effect.gen(function* () {
            yield* Effect.forEach(
              read.plugins.filter(
                (plugin) =>
                  loading && installed.get(plugin.id)?.key !== plugin.key,
              ),
              // Recorded as the load returns, with no gap an interruption
              // could land in: only the load itself is interruptible.
              (plugin) =>
                Effect.uninterruptibleMask((restore) =>
                  Effect.map(restore(holds.loadInstalled(plugin)), (load) => {
                    started.push(load);
                  }),
                ),
              { discard: true },
            );
            return yield* locked(
              Effect.gen(function* () {
                if (reading && readId > applied) {
                  applied = readId;
                  wanted = new Map(
                    read.plugins.map(({ id, key }) => [id, key]),
                  );
                }
                if (reading) {
                  for (const load of started) {
                    const current = installed.get(load.id);
                    // Not wanted by the latest read, or a concurrent step
                    // loaded this key first: keep what is there.
                    if (
                      wanted.get(load.id) !== load.key ||
                      current?.key === load.key
                    ) {
                      yield* retire(load);
                      continue;
                    }
                    // Accepted as current: only now are its tools published.
                    installed.set(load.id, yield* holds.publish(load));
                    adopted.add(load);
                    if (current) yield* retire(current);
                  }
                  for (const [id, current] of installed) {
                    if (wanted.get(id) === current.key) continue;
                    installed.delete(id);
                    yield* retire(current);
                  }
                }
                yield* reconcile(yield* off);
                // Every on plugin's process layer, held until the step has
                // pinned the ones it uses: a flip meanwhile drops none of them.
                const on = [...builtIns.keys()].filter(
                  (id) => table.entries.get(id)!.processLayer !== undefined,
                );
                const bridge = yield* Scope.fork(yield* Effect.scope);
                for (const id of on)
                  yield* RcMap.get(layers, id).pipe(Scope.provide(bridge));
                const layersFor = (plugins: ReadonlySet<string>) =>
                  Effect.reduce(
                    on.filter((id) => plugins.has(id)),
                    () => Context.empty() as Services,
                    (merged, id) =>
                      Effect.map(RcMap.get(layers, id), (services) =>
                        Context.merge(merged, services),
                      ),
                  ).pipe(Effect.ensuring(Scope.close(bridge, Exit.void)));
                return {
                  ...(yield* registry.pin),
                  plugins: [...builtIns.keys()].map((id) =>
                    table.entries.get(id)!,
                  ),
                  layersFor,
                  installed: new Map(
                    loading
                      ? [...installed].map(([id, { source }]) => [id, source])
                      : [],
                  ),
                  warnings: [
                    ...read.warnings,
                    ...(loading
                      ? [...installed.values()].flatMap((load) => load.failures)
                      : []),
                  ],
                };
              }),
            );
          }).pipe(
            Effect.onError(() => dropUnadopted),
            Effect.ensuring(
              Effect.forEach(
                retired,
                (holds) => Scope.close(holds, Exit.void),
                { discard: true },
              ),
            ),
          );
          return pinned;
        });

      const hold = Effect.fn('LiveTools.hold')(function* (
        declared: readonly string[],
      ) {
        const read = yield* loader(declared);
        const loaded = new Map<string, string | undefined>();
        for (const plugin of read.plugins) {
          // The start is interruptible: `holdServer` stops what it started
          // on any exit before it returns.
          const { failure } = yield* Effect.acquireRelease(
            holds.holdServer(plugin, true),
            ({ id }) => holds.release(id),
            { interruptible: true },
          );
          loaded.set(plugin.id, failure);
        }
        return { warnings: read.warnings, loaded };
      });
      const processServices = (id: string) =>
        locked(RcMap.getOption(layers, id));
      const service: LiveTools['Service'] = {
        registry,
        pinSwitched,
        hold,
        processServices,
      };
      yield* locked(reconcile(closed));
      return service;
    }),
  );

/** Loads no plugins, from configuration or installed. */
const NONE = Effect.succeed({ plugins: [], warnings: [] });

/**
 * `table` as the `ToolRegistry`, and the live catalog over it, the plugins
 * `loader` reads and the installed plugins `installed` reads at each step
 * (none when omitted), holding the `closed` plugins off until a step or a
 * caller first applies the switches.
 */
export const toolTableLayer = (
  table: ToolTable,
  loader: PluginLoader = () => NONE,
  closed: ReadonlySet<string> = new Set(),
  installed: InstalledToolReader = NONE,
): Layer.Layer<
  LiveTools | ToolRegistry,
  never,
  Exclude<PluginLayerServices, LiveTools>
> =>
  liveToolsLayer(loader, closed, installed).pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
