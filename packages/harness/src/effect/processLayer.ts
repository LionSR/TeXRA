/**
 * The process every host and embedder runs on: {@link processLayer}
 * composes the process services and the {@link Sessions} service over the
 * process's internal session owner, so a host and an embedder open a root's
 * session the same way. `Sessions.layer` is an embedder's
 * composition of that process from its platform and plugins.
 */
import { Context, Effect, Layer, type ManagedRuntime } from 'effect';

import type { RunServices } from '@agent/runtime/ToolServices';
import { SessionOwner } from '@agent/runtime/rootLaunch';
import { RunLabels } from '@agent/runtime/sessionDescription';
import { globalAppStateLayer } from '@controllers/session/appStateStore';
import {
  ownerProcessLayer,
  type ProcessServicesOptions,
} from '@controllers/session/sessionLayer';
import { installProcessHttpDispatcher } from '@platform/defaults/longRunningModelTransport';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SessionCloseReport } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import { HostSkillSources } from '@skills/runtimeSkills';
import {
  hostSkillContributions,
  type HostSkillOptions,
} from '@skills/skillSources';
import type { ToolCatalog } from '@tools/liveTools';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { toolTable } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { CommandDirs } from '@utils/system/platformPaths';

import { PluginsRefused } from './errors.js';
import { makeSessions } from './sessionPrograms.js';
import type { Composition, LocalSession, OpenOptions } from './sessions.js';

/**
 * The process services a composition root runs on, the public name every
 * host writes against: what a run's program requires of the process
 * ({@link RunServices}) and `ToolCatalog`, the tool catalog each session's
 * steps pin their tools in (its owner's view, `ToolCatalogOwner`, stays
 * inside the composition). Every run and session of the process is provided
 * these; the {@link Sessions} above them is the composition root's alone
 * ({@link ProcessRuntime}).
 */
export type ProcessServices = RunServices | ToolCatalog;

/** What a composition root composes its process from: the services' options
 *  (`ownerProcessLayer`) and its skill sources. */
export interface ProcessLayerOptions extends Omit<
  ProcessServicesOptions,
  'appState'
> {
  /** The host's skill sources; absent, the process discovers no skills. */
  readonly skills?: HostSkillOptions;
  /** The global store: absent, the global root's (`globalAppStateLayer`);
   *  else the SDK's embedder store, or a platform-less CLI entry's refusal. */
  readonly appState?: ProcessServicesOptions['appState'];
}

/** The runtime a composition root makes over `processLayer`: the process
 *  services, and the `Sessions` that open and close its sessions. Its build
 *  cannot fail, so the root has already decided what a `PluginsRefused`
 *  means (a host with a fixed list, `Layer.orDie`). */
export type ProcessRuntime = ManagedRuntime.ManagedRuntime<
  ProcessServices | Sessions,
  never
>;

/**
 * `effect` over this runtime's services (a {@link ProcessRuntime}'s, or a
 * host runtime's that serves more), as a program rather than a run: a
 * composition root hands the process services to a program it must give away
 * (a shutdown handler, a host callback typed as an Effect) without
 * stepping through a Promise to get them. The services are the runtime's own
 * context, built once and cached there, so this is the same provision
 * `runPromise` would have made, minus the boundary.
 */
export function withProcessServices<A, E, R = ProcessServices | Sessions>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, NoInfer<R>>,
): Effect.Effect<A, E> {
  return Effect.flatMap(runtime.contextEffect, (context) =>
    Effect.provide(effect, context),
  );
}

/** The process's sessions: one per workspace storage root, through its one
 *  `SessionOwner`. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session of `roots`, built now or the one already open; `options`
     *  decide its store. */
    readonly open: (
      roots: WorkspaceRoots,
      options?: OpenOptions,
    ) => Effect.Effect<LocalSession, SessionOpenError>;
    /**
     * Refuse new runs, stop the ones it owns, cascading, and wait for them
     * within the close budget; report the ones still live abandoned, flush,
     * release.
     */
    readonly close: (
      roots: WorkspaceRoots,
    ) => Effect.Effect<SessionCloseReport>;
    /** A process shutdown's close: drain what the plugins' pollers
     *  admitted, then close every open session at once, under one
     *  deadline. */
    readonly closeAll: Effect.Effect<readonly SessionCloseReport[]>;
    readonly list: Effect.Effect<readonly LocalSession[]>;
  }
>()('@texra-ai/harness/Sessions') {
  /**
   * The Effect embedder's entry: compose the process from its platform and
   * its plugins (`harnessBuiltins` from `@texra-ai/harness/plugins`, or a
   * list of the embedder's own beside them), and serve its sessions for
   * this layer's lifetime; the layer's release closes every session still
   * open. A list the harness cannot compose fails with
   * {@link PluginsRefused}, as {@link processLayer} says, and the
   * first-install tool switches are seeded into the platform's global
   * state. The harness logs with `Effect.log*` through the loggers, level
   * and tracer the embedder's program provides (`Logger.layer`,
   * `References.MinimumLogLevel`), and installs none of its own.
   *
   * Build it once per process, as any Effect layer is memoized: a second
   * live build that opens a root the first holds is refused at open
   * (`holdProcessRoot`), since both would own its runs.
   */
  static layer({
    platform,
    plugins,
    skills,
  }: Composition): Layer.Layer<Sessions, PluginsRefused> {
    return sessionsLayer({
      storageRoot: platform.roots.storageRoot,
      settings: platform.roots.config.catalog,
      plugins,
      skills,
      secrets: Secrets.layer(platform.secrets),
      appState: seeded(AppState.layer(platform.roots.globalState), plugins),
      agentDirectories: Layer.succeed(AgentDirectories)(
        platform.agentDirectories,
      ),
      commandDirs: platform.commandDirs,
      // No logger of the harness's own: the embedder's logger layer,
      // level and tracer decide where the harness's lines go.
    });
  }
}

/**
 * The process services a composition root runs on and the {@link Sessions}
 * opening, listing and closing its sessions (one per storage root), for a
 * `ManagedRuntime` the host disposes on shutdown. Disposal closes every open
 * session, plugins drained first; a host whose resources must outlive them
 * runs `Sessions.closeAll` first.
 *
 * The host owns its process, so the model transport's dispatcher also
 * becomes the process's global one, and the rest of its HTTP traffic follows
 * the same proxy policy. An embedder's process (`Sessions.layer`) keeps its
 * own global dispatcher: its model traffic carries the transport anyway.
 *
 * A plugin list the harness cannot compose (the defects `toolTable`
 * refuses: an id that is not lowercase letters, digits and dashes, an id or
 * tool name listed twice, a second plugin continuing waiting runs or
 * recording one request kind's decisions, a switch on a plugin with no
 * availability probe) fails the build with {@link PluginsRefused} before
 * anything is built, so the refusal names the plugin rather than failing
 * the first session open. A global store the process builds itself is
 * seeded with the first-install tool switches; a store handed in is left as
 * it is. Every root run is labelled with a short title from the helper model
 * (its `run.description`): an extra model request per root run, outside the
 * run's usage, which every host's run list shows.
 */
export function processLayer(
  options: ProcessLayerOptions,
): Layer.Layer<ProcessServices | Sessions, PluginsRefused> {
  return Layer.merge(
    sessionsLayer(options).pipe(Layer.provide(Layer.succeed(RunLabels)(true))),
    Layer.effectDiscard(Effect.sync(installProcessHttpDispatcher)),
  );
}

/** The store, seeded with the first-install tool switches (opt-in plugins
 *  off) unless the user's list exists: as it is built, so before the tool
 *  catalog first reads the switches (an embedder's store has no change feed
 *  and is read once). A store that cannot be read or written is a platform
 *  defect. */
const seeded = (
  appState: NonNullable<ProcessServicesOptions['appState']>,
  plugins: ProcessLayerOptions['plugins'],
) =>
  appState.pipe(
    Layer.tap((context) =>
      seedDisabledToolDefaults(Context.get(context, AppState), plugins).pipe(
        Effect.orDie,
      ),
    ),
  );

function sessionsLayer(
  options: ProcessLayerOptions,
): Layer.Layer<ProcessServices | Sessions, PluginsRefused> {
  const appState =
    options.appState ??
    seeded(
      globalAppStateLayer(
        resolveGlobalStoragePath(options.storageRoot),
        options.settings,
      ),
      options.plugins,
    );
  const sessions = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      return yield* makeSessions(
        yield* SessionOwner,
        yield* Effect.context<ProcessServices>(),
      );
    }),
  ).pipe(
    Layer.provideMerge(ownerProcessLayer({ ...options, appState })),
    // Beneath every session the process builds, so its runs' steps list
    // what the hosts' settings pages list.
    Layer.provideMerge(
      options.skills === undefined
        ? Layer.empty
        : Layer.succeed(HostSkillSources)({
            resourcesPath: options.skills.resourcesPath,
            options: options.skills.skillSourceOptions ?? {},
            contributions: hostSkillContributions(
              options.plugins.map(({ id }) => id),
              options.skills.projectFolder,
            ),
          }),
    ),
    Layer.provideMerge(
      options.commandDirs === undefined
        ? Layer.empty
        : Layer.succeed(CommandDirs)(options.commandDirs),
    ),
  );
  return Layer.unwrap(
    Effect.try({
      try: () => toolTable(options.plugins),
      catch: (thrown) =>
        new PluginsRefused({ message: toErrorMessage(thrown) }),
    }).pipe(Effect.as(sessions)),
  );
}
