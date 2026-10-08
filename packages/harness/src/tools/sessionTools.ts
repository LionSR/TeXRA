/**
 * One project's side of the tool catalog (`@tools/liveTools`), in its
 * session's scope: each plugin's `sessionLayer` (up while the plugin is on,
 * a step uses it or `PluginHold` holds it) and the MCP servers its runs and
 * steps start with the project's `.env`, kept 30 minutes past their last
 * holder and never past the session's close; none is shared across
 * projects. A step (`pin`) reads the switches and installed plugins once
 * and builds its tools from that read alone, so a run's tools change only
 * there. Each resource is an `RcMap` entry: one build per key, stopped by
 * its last release; a failed or interrupted build is dropped.
 */
import {
  Cause,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  RcMap,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { Runs, type RunRegistry } from '@agent/runtime/runRegistry';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import { ProjectEnvironment } from '@platform/defaults/nodeWorkspace';
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
  type InstalledToolReader,
  type LoadedPlugin,
  type LoadedPluginTools,
  type PluginLoader,
  type SessionPluginLayer,
} from '@tools/toolTable';
import { sha256 } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** What one step pinned: its tools and the plugins they come from. */
export interface ToolStep {
  /** Every tool the step may offer, by name. */
  readonly entries: ReadonlyMap<string, ToolEntry>;
  /** The built-in plugins on as the step read the switches, in list order:
   *  the step reads their continuation and prompt section. */
  readonly plugins: readonly Plugin[];
  /** The installed plugins the step loaded, by id, as read (those that ship
   *  only skills included): its installed skills' source. */
  readonly installed: ReadonlyMap<string, LoadablePlugin>;
  /** Why an installed plugin, one of its servers or an owner whose tool
   *  name another owner holds offers no tools. */
  readonly warnings: readonly string[];
  /** The process and session services of the plugins in `used` that the
   *  step found on, built if down, for the caller's scope. */
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
  /** At a run's start, after evicting failed starts: hold the configured
   *  MCP servers `declared` names, with the caller's project variables. */
  readonly hold: (
    declared: readonly string[],
  ) => Effect.Effect<HeldPlugins, never, Scope.Scope>;
}

/** The process side every session's catalog reads. */
export interface ProcessCatalog {
  /** Each built-in plugin, in list order, with its entries digested once. */
  readonly builtIn: readonly {
    readonly plugin: Plugin;
    readonly entries: ReadonlyMap<string, ToolEntry>;
  }[];
  /** The plugins on when `off` are held off. */
  readonly onOf: (off: ReadonlySet<string>) => ReadonlySet<string>;
  /** The plugins on as the switches stand. */
  readonly on: SubscriptionRef.SubscriptionRef<ReadonlySet<string>>;
  readonly processLayers: RcMap.RcMap<string, PluginContext>;
  readonly sessionLayerOf: ReadonlyMap<string, SessionPluginLayer>;
  readonly spawner: ChildProcessSpawner['Service'];
  readonly loader: PluginLoader;
  readonly installed: InstalledToolReader;
}

/** What a step pins of its session. */
interface SessionResources {
  readonly layers: RcMap.RcMap<string, PluginContext>;
  /** A server of `plugin` for the caller's scope, as entries under
   *  `owner`, or why it has none. */
  readonly holdServer: (
    plugin: LoadedPlugin,
    owner: string,
    load?: string,
  ) => Effect.Effect<
    {
      readonly failure?: string;
      readonly entries: ReadonlyMap<string, ToolEntry>;
    },
    never,
    Scope.Scope
  >;
}

/** One MCP server process, equal by its plugin's spec and revision, the
 *  installed plugin's load key ('' if configured) and the project
 *  variables: a changed one is a new process beside the open ones. */
class ServerKey implements Equal.Equal {
  readonly id: string;
  readonly plugin: LoadedPlugin;
  readonly env: Readonly<Record<string, string>>;

  constructor(
    plugin: LoadedPlugin,
    env: Readonly<Record<string, string>>,
    load: string,
  ) {
    this.plugin = plugin;
    this.env = env;
    this.id = sha256([plugin.id, plugin.spec, plugin.revision, load, env]);
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof ServerKey && that.id === this.id;
  }

  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/** A plugin's layer (from `layers`, by its id) built in the caller's
 *  scope, its coming up and going down logged where the use that caused it
 *  is. Asking for a plugin with no layer there is a defect. */
export const buildPluginLayer = <R>(
  plugin: string,
  layers: ReadonlyMap<string, Layer.Layer<never, never, R>>,
): Effect.Effect<PluginContext, never, Scope.Scope | R> => {
  const layer = layers.get(plugin);
  if (layer === undefined)
    return Effect.die(new Error(`Plugin ${plugin} has no such layer.`));
  return Effect.acquireRelease(
    Effect.logDebug(`Plugin ${plugin}: services up.`),
    () => Effect.logDebug(`Plugin ${plugin}: services down.`),
  ).pipe(
    Effect.andThen(Layer.build(layer)),
    // cast: erased; a plugin's layer serves its own code, which names its tags.
    Effect.map((services) => services as PluginContext),
    withLogChannel('PluginLayers'),
  );
};

/**
 * Keep `hold(id)` up for each of `ids` the latest `on` names, forked in the
 * caller's scope: a change holds the new set before it lets the old go, so
 * a plugin on in both is never rebuilt. Each hold has its own scope, closed
 * at once if it fails (dropping the failed entry). A failed hold is logged
 * and tried again in the background, backing off to once a minute, until
 * it holds or the next change replaces the set, so a plugin left on keeps
 * its standing services after a transient failure.
 */
export const follow = (
  on: Stream.Stream<ReadonlySet<string>>,
  ids: readonly string[],
  hold: (id: string) => Effect.Effect<unknown, never, Scope.Scope>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let standing: Scope.Closeable | undefined;
    yield* Stream.runForEach(on, (switchedOn) =>
      Effect.gen(function* () {
        const next = yield* Scope.fork(scope);
        yield* Effect.forEach(
          ids.filter((id) => switchedOn.has(id)),
          (id) => {
            const attempt = Effect.flatMap(Scope.fork(next), (own) =>
              hold(id).pipe(
                Scope.provide(own),
                Effect.onError(() => Scope.close(own, Exit.void)),
              ),
            ).pipe(
              Effect.sandbox,
              Effect.tapError((cause) =>
                Effect.logError(
                  `Plugin ${id}'s services did not come up: ${toErrorMessage(Cause.squash(cause))}`,
                ),
              ),
            );
            return attempt.pipe(
              Effect.catch(() =>
                attempt.pipe(
                  Effect.retry({ schedule: HOLD_RETRY }),
                  Effect.ignore({ log: 'Error' }),
                  Effect.forkIn(next),
                ),
              ),
            );
          },
          { concurrency: 'unbounded', discard: true },
        );
        if (standing !== undefined) yield* Scope.close(standing, Exit.void);
        standing = next;
      }),
    );
  }).pipe(Effect.forkScoped, Effect.asVoid);

/** A failed standing hold's retries: from a second, doubling, to a minute. */
const HOLD_RETRY = Schedule.min([
  Schedule.exponential('1 second'),
  Schedule.spaced('1 minute'),
]);

/** How long an MCP server no run or step holds stays up for the next: long
 *  enough to read an answer before replying. In the service, a session left
 *  idle closes sooner (`texra serve --idle-timeout`), and a session's close
 *  always stops its servers. */
const SERVER_IDLE = Duration.minutes(30);

/** Reads no plugins, from configuration or installed. */
export const NONE = Effect.succeed({ plugins: [], warnings: [] });

/** One step's pin over its session's resources. */
const pinStep = <E>(
  shared: ProcessCatalog,
  session: SessionResources,
  off: Effect.Effect<ReadonlySet<string>, E>,
  options?: { readonly installed?: boolean; readonly held?: HeldPlugins },
): Effect.Effect<ToolStep, E, Scope.Scope> =>
  Effect.gen(function* () {
    const switchedOn = shared.onOf(yield* off);
    const builtIn = shared.builtIn.filter(({ plugin }) =>
      switchedOn.has(plugin.id),
    );
    const plugins = builtIn.map(({ plugin }) => plugin);
    const read =
      options?.installed === true ? yield* shared.installed : yield* NONE;
    // Each installed plugin's servers, started with this project's
    // variables, for the step's scope.
    const loads = yield* Effect.forEach(
      read.plugins,
      ({ id, key, servers }) =>
        Effect.map(
          Effect.forEach(
            servers,
            (server) => session.holdServer(server, id, key),
            { concurrency: 'unbounded' },
          ),
          (held) => ({ id, held }),
        ),
      { concurrency: 'unbounded' },
    );
    // An installed plugin's tools go before a configured server's: a
    // child inheriting one keeps it when a configured server reuses the
    // name, and the configured one is refused loudly.
    const merged = mergeEntries([
      ...builtIn.map(({ plugin, entries }) => [plugin.id, entries] as const),
      ...loads.map(
        ({ id, held }) =>
          [id, new Map(held.flatMap(({ entries }) => [...entries]))] as const,
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
      installed: new Map(read.plugins.map(({ id, source }) => [id, source])),
      warnings: [...read.warnings, ...failures, ...merged.warnings],
      services: (used) =>
        Effect.reduce(
          plugins.filter(({ id }) => used.has(id)),
          // cast: the empty context serves no plugin's tag.
          () => Context.empty() as PluginContext,
          (services, { id, processLayer, sessionLayer }) =>
            Effect.gen(function* () {
              const forProcess = processLayer
                ? yield* RcMap.get(shared.processLayers, id)
                : Context.empty();
              const forSession = sessionLayer
                ? yield* RcMap.get(session.layers, id)
                : Context.empty();
              return Context.merge(
                Context.merge(services, forProcess),
                forSession,
              );
            }),
        ),
    };
  });

/** One session's catalog over `shared`, in the caller's scope. */
export const sessionTools = Effect.fnUntraced(function* (
  shared: ProcessCatalog,
  runs: () => RunRegistry,
) {
  const scope = yield* Effect.scope;
  // A hold on one plugin's build, taken now, released when `until` ends
  // (or the session closes).
  const holdFor =
    (id: string) =>
    (until: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const hold = yield* Scope.fork(scope);
        yield* RcMap.get(layers, id).pipe(Scope.provide(hold));
        yield* until.pipe(
          Effect.ensuring(Scope.close(hold, Exit.void)),
          Effect.forkIn(scope),
        );
      });
  const layers: RcMap.RcMap<string, PluginContext> = yield* RcMap.make({
    lookup: (id: string) =>
      buildPluginLayer(id, shared.sessionLayerOf).pipe(
        Effect.provideService(Runs, runs()),
        Effect.provideService(PluginHold, holdFor(id)),
      ),
  });
  // A server outlives its last holder by `SERVER_IDLE`, so the project's
  // next run (a chat's next message) reuses the process and its state; a
  // superseded key's process stops once that idle time passes, and the
  // session's close stops every one.
  const servers: RcMap.RcMap<ServerKey, LoadedPluginTools> = yield* RcMap.make({
    lookup: (key: ServerKey) =>
      key.plugin.acquire.pipe(
        Effect.provideService(ChildProcessSpawner, shared.spawner),
        Effect.provideService(ProjectEnvironment, key.env),
      ),
    idleTimeToLive: SERVER_IDLE,
  });
  yield* follow(
    SubscriptionRef.changes(shared.on),
    [...shared.sessionLayerOf.keys()],
    (id) => RcMap.get(layers, id),
  );
  // Servers that did not start stay failed until the next run starts
  // (`hold`), so no step waits on a dead start twice in one run.
  const failed = new Set<ServerKey>();
  const holdServer: SessionResources['holdServer'] = (
    plugin,
    owner,
    load = '',
  ) =>
    Effect.gen(function* () {
      const key = new ServerKey(plugin, yield* ProjectEnvironment, load);
      const { tools, failure } = yield* RcMap.get(servers, key);
      if (failure !== undefined) failed.add(key);
      const revision = sha256({ spec: plugin.spec, env: plugin.revision });
      return { failure, entries: entriesOf(owner, tools, { revision }) };
    });
  const resources = { layers, holdServer };
  return {
    pin: (off, options) => pinStep(shared, resources, off, options),
    hold: Effect.fn('ToolCatalog.hold')(function* (declared) {
      for (const key of failed) yield* RcMap.invalidate(servers, key);
      failed.clear();
      const read = yield* shared.loader(declared);
      const held = yield* Effect.forEach(
        read.plugins,
        (plugin) =>
          Effect.map(holdServer(plugin, plugin.id), (server) => ({
            id: plugin.id,
            ...server,
          })),
        { concurrency: 'unbounded' },
      );
      return {
        warnings: read.warnings,
        loaded: new Map(held.map(({ id, failure }) => [id, failure])),
        entries: new Map(held.flatMap(({ entries }) => [...entries])),
      };
    }),
  } satisfies SessionTools;
});
