/**
 * The process's live tool catalog: `Registry`s (`@tools/liveRegistry`) of
 * every tool some plugin contributes (by tool name), every continuation (by
 * agent category) and every prompt contribution (by plugin).
 *
 * - **Built-in plugins** contribute all three while their switch is on.
 *   `pinSwitched` reads the switches, reconciles the contributions with them
 *   and pins the generations that produces, as one serialized step. A run's
 *   step opens through it (`@agent/runtime/loop/step`), so a switch flipped
 *   by any host, or by `texra tools` from another shell, reaches every open
 *   run at its next step.
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
 * - **Plugin layers** (`PLUGIN_PROCESS_LAYERS`) are up while their plugin is
 *   on or a pinned generation holds it (`@tools/pluginLayers` builds a
 *   session's `PLUGIN_SESSION_LAYERS` by the same rule).
 *
 * Each entry carries its identity (the digest of its name and input schema,
 * its plugin's id and revision), which a call is checked against.
 */
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  RcMap,
  Scope,
  Semaphore,
} from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { InstalledPluginLoad } from '@common/plugins/pluginTrust';
import type { PluginServices } from '@platform/processRuntime';
import type { AgentCategory } from '@shared/schemas';
import {
  makeRegistry,
  type Generation,
  type Pinned,
  type Registry,
} from '@tools/liveRegistry';
import {
  ToolRegistry,
  type InstalledToolReader,
  type PluginLoader,
  type PromptContribution,
  type ToolTable,
} from '@tools/toolTable';
import {
  entriesOf,
  sha256,
  type ContinuationEntry,
  type HeldPlugins,
  type ToolEntry,
} from '@tools/catalogEntries';
import { makeServerHolds, type InstalledLoad } from '@tools/serverHolds';
import { buildPluginLayer } from '@tools/pluginLayers';

/** The services a pin serves: its plugins' layers'. */
type Services = Context.Context<PluginServices>;

/** How a pin reads the installed plugins (`LiveTools.pinSwitched`). */
type PinInstalled =
  | { readonly installed: true; readonly read?: InstalledPluginLoad }
  | { readonly installed: 'withdraw' };

export class LiveTools extends Context.Service<
  LiveTools,
  {
    readonly registry: Registry<string, ToolEntry, void>;
    /**
     * Read the switches, contribute exactly the built-in plugins they leave
     * on, and pin the tool, continuation and prompt generations that produces, as
     * one serialized step: a concurrent step's older read never reverts the
     * catalog under it, and no step pins a generation built from switches
     * it did not read.
     */
    readonly pinSwitched: <E>(
      off: Effect.Effect<ReadonlySet<string>, E>,
      /**
       * Also read the installed plugins: `true` loads them as they stand (a
       * run's step), from `read` when the step brings its launch's read,
       * so one read serves each step; `'withdraw'` only withdraws those
       * disabled, removed or changed since they loaded, starting nothing (a
       * switch follower).
       */
      options?: PinInstalled,
    ) => Effect.Effect<
      Pinned<string, ToolEntry, void> & {
        /** Pin the process services of the plugins the step uses, from the
         *  plugins on when it pinned, for the caller's scope. */
        readonly layersFor: (
          plugins: ReadonlySet<string>,
        ) => Effect.Effect<Services, never, Scope.Scope>;
        readonly continuations: Generation<AgentCategory, ContinuationEntry>;
        /** Each switched-on plugin's prompt contribution, by plugin id. */
        readonly sections: Generation<string, PromptContribution>;
        /** Why each enabled installed plugin, or one of its servers, offers
         *  no tools; empty unless the installed plugins were loaded. */
        readonly warnings: readonly string[];
      },
      E,
      Scope.Scope
    >;
    /** A plugin's process services for the caller's scope while its layer
     *  is up (switched on, or pinned by a step that uses it), for a host that
     *  shows, ends or drains its state; none once it is down. */
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
): Layer.Layer<LiveTools, never, ToolRegistry | ChildProcessSpawner> =>
  Layer.effect(
    LiveTools,
    Effect.gen(function* () {
      const table: ToolTable = yield* ToolRegistry;
      const spawner = yield* ChildProcessSpawner;
      const scope = yield* Effect.scope;
      // Each plugin's process layer, in its map entry's scope: its switch and
      // each generation that includes it hold a reference. It may read this
      // catalog (Copilot's tools follow it), built by then.
      const self: { service?: LiveTools['Service'] } = {};
      // The plugins whose process layer is up, however it is held.
      const up = new Set<string>();
      const layers = yield* RcMap.make({
        lookup: (id: string) =>
          buildPluginLayer(id, table.processLayers.get(id)!.layer).pipe(
            Effect.provideService(LiveTools, self.service!),
            Effect.tap(() =>
              Effect.acquireRelease(
                Effect.sync(() => up.add(id)),
                () => Effect.sync(() => up.delete(id)),
              ),
            ),
          ),
      });
      // Each built-in plugin's open contribution, closed when switched off,
      // and each installed plugin's load, by id.
      const builtIns = new Map<string, Scope.Closeable>();
      const installed = new Map<string, InstalledLoad>();
      // Each step's read of the installed plugins is numbered as it begins,
      // and only a read newer than the last one applied is applied: a slow
      // load from an older read never reverts a newer one.
      let reads = 0;
      let applied = 0;
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
        digest: (entries) =>
          sha256(
            [...entries]
              .map(([name, e]) => [
                name,
                e.digest,
                e.shown,
                e.plugin,
                e.revision,
              ])
              .toSorted(([a], [b]) => Number(a > b) - Number(a < b)),
          ),
        // The server processes the generation dispatches through.
        acquire: holds.pinHolds,
      });

      // Each built-in plugin's continuation, by category; it holds nothing.
      const continuations = yield* makeRegistry<
        AgentCategory,
        ContinuationEntry,
        void
      >({
        digest: (entries) =>
          sha256(
            [...entries]
              .map(([category, { plugin }]) => [category, plugin])
              .toSorted(([a], [b]) => Number(a > b) - Number(a < b)),
          ),
        acquire: () => Effect.void,
      });
      // Each built-in plugin's prompt contribution, by plugin id.
      const sections = yield* makeRegistry<string, PromptContribution, void>({
        digest: (entries) => sha256([...entries.keys()].toSorted()),
        acquire: () => Effect.void,
      });

      /** Open and close the built-in contributions (a plugin's tools,
       *  continuation, prompt contribution and process layer, in one
       *  scope) to match `off`. */
      const reconcile = (off: ReadonlySet<string>) =>
        Effect.gen(function* () {
          for (const id of new Set([
            ...table.plugins.keys(),
            ...table.continuations.keys(),
            ...table.prompt.keys(),
            ...table.processLayers.keys(),
          ])) {
            const on = !off.has(id);
            const held = builtIns.get(id);
            if (on && held === undefined) {
              const contribution = yield* Scope.fork(scope);
              const continuation = table.continuations.get(id);
              const prompt = table.prompt.get(id);
              // The manifest rules out a name two plugins share, so a
              // conflict between built-in plugins is a defect.
              yield* Effect.all([
                registry.contribute(
                  id,
                  entriesOf(id, table.plugins.get(id) ?? new Map()),
                ),
                continuations.contribute(
                  id,
                  new Map(
                    continuation === undefined
                      ? []
                      : [[continuation.category, { plugin: id, continuation }]],
                  ),
                ),
                sections.contribute(
                  id,
                  new Map(prompt === undefined ? [] : [[id, prompt]]),
                ),
              ]).pipe(Scope.provide(contribution), Effect.orDie);
              // The switch's own hold on the plugin's process services.
              if (table.processLayers.has(id))
                yield* RcMap.get(layers, id).pipe(Scope.provide(contribution));
              builtIns.set(id, contribution);
            } else if (!on && held !== undefined) {
              builtIns.delete(id);
              yield* Scope.close(held, Exit.void);
            }
          }
        });
      const pinSwitched = <E>(
        off: Effect.Effect<ReadonlySet<string>, E>,
        options?: PinInstalled,
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
            ? yield* installedReader(
                options?.installed === true ? options.read : undefined,
              )
            : { plugins: [], warnings: [] };
          // Loads started here and not yet adopted by the catalog: an
          // interruption or failure before adoption drops them.
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
                if (reading && readId <= applied) {
                  // A newer read was applied meanwhile: this one is stale.
                  for (const load of started) yield* retire(load);
                } else if (reading) {
                  applied = readId;
                  const wanted = new Map(
                    read.plugins.map(({ id, key }) => [id, key]),
                  );
                  for (const load of started) {
                    const current = installed.get(load.id);
                    // A concurrent step loaded this key first: keep its load.
                    if (current?.key === load.key) {
                      yield* retire(load);
                      continue;
                    }
                    installed.set(load.id, load);
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
                const { generation } = yield* continuations.pin;
                const pinned = yield* sections.pin;
                // Every on plugin's process layer, held until the step has
                // pinned the ones it uses: a flip meanwhile drops none of them.
                const on = [...builtIns.keys()].filter((id) =>
                  table.processLayers.has(id),
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
                  continuations: generation,
                  sections: pinned.generation,
                  layersFor,
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
        locked(
          up.has(id)
            ? Effect.map(RcMap.get(layers, id), Option.some)
            : Effect.succeed(Option.none()),
        );
      self.service = { registry, pinSwitched, hold, processServices };
      yield* locked(reconcile(closed));
      return self.service;
    }),
  );

/** Loads no plugins, from configuration or installed. */
const NONE = () => Effect.succeed({ plugins: [], warnings: [] });

/**
 * `table` as the `ToolRegistry`, and the live catalog over it, the plugins
 * `loader` reads and the installed plugins `installed` reads at each step
 * (none when omitted), holding the `closed` plugins off until a step or a
 * caller first applies the switches.
 */
export const toolTableLayer = (
  table: ToolTable,
  loader: PluginLoader = NONE,
  closed: ReadonlySet<string> = new Set(),
  installed: InstalledToolReader = NONE,
): Layer.Layer<LiveTools | ToolRegistry, never, ChildProcessSpawner> =>
  liveToolsLayer(loader, closed, installed).pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
