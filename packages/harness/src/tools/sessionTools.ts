/**
 * One project's side of the tool catalog (`ToolCatalog`), in its
 * session's scope: each plugin revision's `sessionLayer` (up while the
 * plugin is on or loaded, a step uses it or `PluginHold` holds it) and the
 * MCP servers its runs and steps start with the project's `.env`, kept 30
 * minutes past their last holder and never past the session's close; none
 * is shared across projects. A step (`pin`) reads the switches and the
 * installed plugins once, the native plugins they load among them, and
 * builds its tools and its plugin table from that read alone, so a run's
 * tools change only there. Each resource is an `RcMap` entry: one build per
 * key, stopped by its last release, at once. A plugin's layers are keyed by
 * its id and revision (`LayerKey`), so a replaced native plugin builds its
 * new revision beside the old one, which a step that pinned the old keeps
 * until that step ends; nothing is interrupted. An interrupted build is
 * dropped; a failed one answers its failure to every holder until its last
 * release. An MCP server's failed start is held as a value instead, so the
 * project's next root run can retry it (`projectServers`).
 */
import {
  Context,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  RcMap,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import { ensureError } from '@utils/errors/errorMessage';
import type { PluginContext } from '@platform/processRuntime';
import {
  entriesOf,
  mergeEntries,
  type HeldPlugins,
  type ToolEntry,
} from '@tools/catalogEntries';
import type { Plugin } from '@tools/plugins';
import {
  PluginHold,
  ToolRegistry,
  type NativePlugin,
  type ToolTable,
} from '@tools/toolTable';
import {
  projectServers,
  type InstalledToolReader,
  type PluginLoader,
  type ProjectServers,
} from '@tools/mcp/mcpConfig';

/** What one step pinned: its tools and the plugins they come from. */
export interface ToolStep {
  /** Every tool the step may offer, by name. */
  readonly entries: ReadonlyMap<string, ToolEntry>;
  /** The built-in plugins on as the step read the switches, in list order,
   *  then the native plugins it loaded: the step reads their programs and
   *  prompt sections. */
  readonly plugins: readonly Plugin[];
  /** The plugin table the step read: the listed plugins and the native
   *  ones it loaded. Its calls read it as their `ToolRegistry`. */
  readonly table: ToolTable;
  /** The modules its scripts may import, source by specifier: each of the
   *  on built-in and loaded native plugins' `scriptModules` as
   *  `builtIn:<name>`, and each program of the installed plugins it loaded
   *  as `<plugin>:<name>`. The programs its scripts may start are those
   *  plugins' `programs`. The step adds the programs its project's agent
   *  wrote for itself. */
  readonly modules: { readonly [specifier: string]: string };
  /** The installed plugins the step loaded, by id, as read (those that ship
   *  only skills included): its installed skills' source. */
  readonly installed: ReadonlyMap<string, LoadablePlugin>;
  /** Why an installed plugin, its native entry, one of its servers or an
   *  owner whose tool name another owner holds offers no tools. */
  readonly warnings: readonly string[];
  /** The process and session services of the plugins in `used` that the
   *  step found on, at the revision it found, built if down, for the
   *  caller's scope, with the step's table as the `ToolRegistry`. */
  readonly services: (
    used: ReadonlySet<string>,
  ) => Effect.Effect<PluginContext, never, Scope.Scope>;
}

/** One session's (one project's) side of the catalog. */
export interface SessionTools {
  /** Read the switches (`off`: the ids held off; only a switched plugin's
   *  count) and, with `installed`, the installed plugins, and pin the tools
   *  that read gives, with the run's `held` servers' tools, for the
   *  caller's scope. */
  readonly pin: <E>(
    off: Effect.Effect<ReadonlySet<string>, E>,
    options?: { readonly installed?: boolean; readonly held?: HeldPlugins },
  ) => Effect.Effect<ToolStep, E, Scope.Scope>;
  /** The plugin table now: the listed plugins and the native ones the
   *  installed plugins load as read now. A launch no run's step made reads
   *  its `ToolRegistry` here. */
  readonly table: Effect.Effect<ToolTable>;
  /** The table the latest read published, reading nothing: a child's
   *  launch takes its `ToolRegistry` here, as its parent's step read the
   *  installed plugins in the step that launched it. */
  readonly published: Effect.Effect<ToolTable>;
  /** At a run's start (a root run first evicts failed starts): hold the
   *  configured MCP servers `declared` names, with the project variables. */
  readonly hold: (
    declared: readonly string[],
    root: boolean,
  ) => Effect.Effect<HeldPlugins, never, Scope.Scope>;
}

/** The installed plugins as one read found them, with the table the
 *  listed plugins and their native plugins make. */
export interface CatalogRead {
  readonly installed: Effect.Success<InstalledToolReader>;
  readonly table: ToolTable;
  /** Why an installed plugin, or its native entry, is not loaded. */
  readonly warnings: readonly string[];
}

/** The process side every session's catalog reads. */
export interface ProcessCatalog {
  /** The listed plugins' table, which every table the reads make extends. */
  readonly listed: ToolTable;
  /** Each built-in plugin, in list order, with its entries digested once. */
  readonly builtIn: readonly {
    readonly plugin: Plugin;
    readonly entries: ReadonlyMap<string, ToolEntry>;
  }[];
  /** The plugins on when `off` are held off. */
  readonly onOf: (off: ReadonlySet<string>) => ReadonlySet<string>;
  /** The plugins on as the switches stand. */
  readonly on: SubscriptionRef.SubscriptionRef<ReadonlySet<string>>;
  /** The plugin table as the latest read found it: what the plugins'
   *  layers outside any step follow. */
  readonly live: SubscriptionRef.SubscriptionRef<ToolTable>;
  /** Read the installed plugins and the native ones they load, and publish
   *  the table they make as `live`. */
  readonly read: Effect.Effect<CatalogRead>;
  /** Record that `native`'s services did not come up, for `reason`: the
   *  reads from now on leave the revision before it in use, or withhold
   *  the plugin, until its trust digest changes. */
  readonly layerFailed: (
    native: NativePlugin,
    reason: string,
  ) => Effect.Effect<void>;
  readonly processLayers: RcMap.RcMap<LayerKey, PluginContext>;
  readonly spawner: ChildProcessSpawner['Service'];
  readonly loader: PluginLoader;
}

/** The key a plugin's layers are kept under, with the plugin they are
 *  built from: its id, and for a native plugin the revision it was loaded
 *  at (`ToolTable.revisionOf`). Two keys of one revision are equal. */
export class LayerKey implements Equal.Equal {
  readonly name: string;
  readonly plugin: Plugin;

  constructor(plugin: Plugin, revision: string) {
    this.plugin = plugin;
    this.name = revision === 'builtin' ? plugin.id : `${plugin.id}@${revision}`;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof LayerKey && that.name === this.name;
  }

  [Hash.symbol](): number {
    return Hash.string(this.name);
  }
}

/**
 * The keys of the plugins whose `pick` layer is held outside any step: a
 * listed plugin's while it is switched on, a native one's while the latest
 * read loads it.
 */
export const heldKeys = (
  shared: Pick<ProcessCatalog, 'on' | 'live'>,
  pick: (plugin: Plugin) => unknown,
): Stream.Stream<ReadonlySet<LayerKey>> =>
  Stream.zipLatest(
    SubscriptionRef.changes(shared.on),
    SubscriptionRef.changes(shared.live),
  ).pipe(
    Stream.map(
      ([on, table]) =>
        new Set(
          [
            ...[...table.entries.values()]
              .filter(({ id }) => on.has(id))
              .map((plugin) => new LayerKey(plugin, 'builtin')),
            ...table.natives.map(
              ({ plugin, revision }) => new LayerKey(plugin, revision),
            ),
          ].filter(({ plugin }) => pick(plugin) !== undefined),
        ),
    ),
  );

/** What a step pins of its session. */
interface SessionResources {
  readonly layers: RcMap.RcMap<LayerKey, PluginContext>;
  readonly holdServer: ProjectServers['holdServer'];
}

/** The plugin layer kept under `key` built in the caller's scope, its
 *  coming up and going down logged where the use that caused it is. Asking
 *  for a key with no layer is a defect. */
export const buildPluginLayer = <R>(
  { name }: LayerKey,
  layer: Layer.Layer<never, never, R> | undefined,
): Effect.Effect<PluginContext, never, Scope.Scope | R> => {
  if (layer === undefined)
    return Effect.die(new Error(`Plugin ${name} has no such layer.`));
  return Effect.acquireRelease(
    Effect.logDebug(`Plugin ${name}: services up.`),
    () => Effect.logDebug(`Plugin ${name}: services down.`),
  ).pipe(
    Effect.andThen(Layer.build(layer)),
    // cast: erased; a plugin's layer serves its own code, which names its tags.
    Effect.map((services) => services as PluginContext),
    withLogChannel('PluginLayers'),
  );
};

/**
 * Keep `hold(key)` up for each key the latest `keys` names, forked in the
 * caller's scope: a change holds the new set before it lets the old go, so
 * a plugin revision held in both is never rebuilt, and a replaced
 * revision's new layer is up before the old one is let go. Each hold has
 * its own scope, closed at once if it fails (dropping the failed entry). A
 * hold that fails is told once: the next step that uses the plugin builds
 * its layer again (`ToolStep.services`), and fails with it if it still
 * cannot.
 */
export const follow = (
  keys: Stream.Stream<ReadonlySet<LayerKey>>,
  hold: (key: LayerKey) => Effect.Effect<unknown, never, Scope.Scope>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let standing: Scope.Closeable | undefined;
    yield* Stream.runForEach(keys, (held) =>
      Effect.gen(function* () {
        const next = yield* Scope.fork(scope);
        yield* Effect.forEach(
          held,
          (key) =>
            Effect.flatMap(Scope.fork(next), (own) =>
              hold(key).pipe(
                Scope.provide(own),
                Effect.onError(() => Scope.close(own, Exit.void)),
              ),
            ).pipe(
              Effect.sandbox,
              Effect.ignore({
                log: 'Error',
                message: `Plugin ${key.name}'s services did not come up; the next step that uses them builds them again.`,
              }),
            ),
          { concurrency: 'unbounded', discard: true },
        );
        if (standing !== undefined) yield* Scope.close(standing, Exit.void);
        standing = next;
      }),
    );
  }).pipe(Effect.forkScoped, Effect.asVoid);

/** A plugin that has no layer of a kind holds none. */
const NOTHING = Effect.void;

/** Reads no plugins, from configuration or installed. */
export const NONE = Effect.succeed({
  plugins: [],
  warnings: [],
  enabled: new Set<string>(),
});

/** One step's pin over its session's resources. */
const pinStep = Effect.fn('sessionTools.pinStep')(function* <E>(
  shared: ProcessCatalog,
  session: SessionResources,
  off: Effect.Effect<ReadonlySet<string>, E>,
  options?: { readonly installed?: boolean; readonly held?: HeldPlugins },
): Effect.fn.Return<ToolStep, E, Scope.Scope> {
  const [offSet, first] = yield* Effect.all(
    [
      off,
      options?.installed === true
        ? shared.read
        : // Without the installed plugins, no native one: the listed
          // plugins' table.
          Effect.map(NONE, (installed) => ({
            installed,
            table: shared.listed,
            warnings: [],
          })),
    ],
    { concurrency: 'unbounded' },
  );
  // The native plugins the read loaded, as the table accepted them, each
  // with its layers up for the step before the step offers anything of it.
  // A revision whose layer fails to build, or dies building, is recorded
  // as failed and the plugins read again, which leaves the revision before
  // it in use or withholds the plugin with the reason; each pass records
  // another failed revision, so it ends.
  let read = first;
  for (;;) {
    const { table } = read;
    const built = yield* Effect.forEach(
      table.natives,
      ({ plugin, revision }) => {
        const key = new LayerKey(plugin, revision);
        return Effect.all(
          [
            plugin.processLayer
              ? RcMap.get(shared.processLayers, key)
              : NOTHING,
            plugin.sessionLayer ? RcMap.get(session.layers, key) : NOTHING,
          ],
          { concurrency: 'unbounded', discard: true },
        ).pipe(
          Effect.catchDefect(Effect.fail),
          Effect.matchEffect({
            onSuccess: () => Effect.succeed(false),
            onFailure: (cause) =>
              Effect.as(
                shared.layerFailed(
                  { plugin, revision },
                  `its services did not come up: ${ensureError(cause).message}`,
                ),
                true,
              ),
          }),
        );
      },
      { concurrency: 'unbounded' },
    );
    if (!built.includes(true)) break;
    read = yield* shared.read;
  }
  const { table } = read;
  const switchedOn = shared.onOf(offSet);
  const builtIn = shared.builtIn.filter(({ plugin }) =>
    switchedOn.has(plugin.id),
  );
  const natives = table.natives.map(({ plugin }) => plugin);
  const plugins = [...builtIn.map(({ plugin }) => plugin), ...natives];
  // Each installed plugin's servers, started with this project's
  // variables, for the step's scope.
  const loads = yield* Effect.forEach(
    read.installed.plugins,
    ({ id, servers, source }) =>
      Effect.map(
        Effect.forEach(
          servers,
          (server) => session.holdServer(server, source.trust.digest),
          { concurrency: 'unbounded' },
        ),
        (held) => ({ id, held }),
      ),
    { concurrency: 'unbounded' },
  );
  // An installed plugin's tools go before a configured server's: a
  // child inheriting one keeps it when a configured server reuses the
  // name, and the configured one is refused loudly. Its native plugin's
  // tools go before its servers'.
  const merged = mergeEntries([
    ...builtIn.map(({ plugin, entries }) => [plugin.id, entries] as const),
    ...natives.map(
      ({ id, tools = [] }) =>
        [id, entriesOf(id, tools, { revision: table.revisionOf(id) })] as const,
    ),
    ...loads.map(
      ({ id, held }) =>
        [
          id,
          new Map(
            held.flatMap(({ tools, revision }) => [
              ...entriesOf(id, tools.values(), { revision }),
            ]),
          ),
        ] as const,
    ),
    ...[
      ...Map.groupBy(
        options?.held?.entries ?? new Map<string, ToolEntry>(),
        ([, entry]) => entry.plugin,
      ),
    ].map(([owner, own]) => [owner, new Map(own)] as const),
  ]);
  const failures = loads.flatMap(({ held }) =>
    held.flatMap(({ failure }) => failure ?? []),
  );
  return {
    entries: merged.entries,
    plugins,
    table,
    modules: Object.fromEntries([
      ...plugins.flatMap(({ scriptModules = {} }) =>
        Object.entries(scriptModules).map(([name, source]) => [
          `builtIn:${name}`,
          source,
        ]),
      ),
      ...read.installed.plugins.flatMap(({ source }) =>
        source.plugin.programs.loaded.map(({ name, source: text }) => [
          name,
          text,
        ]),
      ),
    ]),
    installed: new Map(
      read.installed.plugins.map(({ id, source }) => [id, source]),
    ),
    warnings: [...read.warnings, ...failures, ...merged.warnings],
    services: (used) =>
      Effect.reduce(
        plugins.filter(({ id }) => used.has(id)),
        // cast: the step's table is the one service every call reads; the
        // plugins' own are erased.
        () => Context.make(ToolRegistry, table) as PluginContext,
        Effect.fnUntraced(function* (services, plugin) {
          const { id, processLayer, sessionLayer } = plugin;
          const key = new LayerKey(plugin, table.revisionOf(id));
          const forProcess = processLayer
            ? yield* RcMap.get(shared.processLayers, key)
            : Context.empty();
          const forSession = sessionLayer
            ? yield* RcMap.get(session.layers, key)
            : Context.empty();
          return Context.merge(Context.merge(services, forProcess), forSession);
        }),
      ),
  };
});

/** One session's catalog over `shared`, in the caller's scope. */
export const sessionTools = Effect.fnUntraced(function* (
  shared: ProcessCatalog,
) {
  const scope = yield* Effect.scope;
  // A hold on one plugin revision's build, taken now, released when
  // `until` ends (or the session closes).
  const holdFor =
    (key: LayerKey) =>
    (until: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const hold = yield* Scope.fork(scope);
        yield* RcMap.get(layers, key).pipe(Scope.provide(hold));
        yield* until.pipe(
          Effect.ensuring(Scope.close(hold, Exit.void)),
          Effect.forkIn(scope),
        );
      });
  const layers: RcMap.RcMap<LayerKey, PluginContext> = yield* RcMap.make({
    lookup: (key: LayerKey) =>
      buildPluginLayer(key, key.plugin.sessionLayer).pipe(
        Effect.provideService(PluginHold, holdFor(key)),
      ),
  });
  yield* follow(
    heldKeys(shared, ({ sessionLayer }) => sessionLayer),
    (key) => RcMap.get(layers, key),
  );
  const servers = yield* projectServers(shared.spawner, shared.loader);
  const resources = { layers, holdServer: servers.holdServer };
  return {
    pin: <E>(
      off: Effect.Effect<ReadonlySet<string>, E>,
      options?: Parameters<SessionTools['pin']>[1],
    ) => pinStep(shared, resources, off, options),
    table: Effect.map(shared.read, ({ table }) => table),
    published: SubscriptionRef.get(shared.live),
    hold: (declared, root) =>
      Effect.map(servers.hold(declared, root), ({ warnings, held }) => ({
        warnings,
        loaded: new Map(held.map(({ id, failure }) => [id, failure])),
        entries: new Map(
          held.flatMap(({ id, tools, revision }) => [
            ...entriesOf(id, tools.values(), { revision }),
          ]),
        ),
      })),
  } satisfies SessionTools;
});
