/**
 * The process every host and embedder runs on: {@link processLayer}
 * composes the process services and the {@link Sessions} service over the
 * process's internal session owner, so a host and an embedder open a root's
 * session the same way. `Sessions.layer` is an embedder's
 * composition of that process from its platform and plugins.
 */
import { Context, Effect, Layer } from 'effect';

import {
  ownerProcessLayer,
  type ProcessLayerOptions,
} from '@controllers/session/sessionLayer';
import { SessionOwner, type ProcessServices } from '@platform/processRuntime';
import { installProcessHttpDispatcher } from '@platform/defaults/longRunningModelTransport';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SessionCloseReport } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { toolTable } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { PluginsRefused } from './errors.js';
import { makeSessions } from './sessionPrograms.js';
import type { Composition, LocalSession, OpenOptions } from './sessions.js';

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
     * Refuse new runs, settle the ones it owns inside the runtime's
     * shutdown-phase budget, flush, release.
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
   * open. A plugin list the harness cannot compose (the defects `toolTable`
   * refuses: an id that is not lowercase letters, digits and dashes, an id
   * or tool name listed twice, a second plugin continuing parked runs or
   * recording one request kind's decisions, a switch on a plugin with no
   * availability probe) fails with {@link PluginsRefused}, before anything
   * is built.
   *
   * Build it once per process, as any Effect layer is memoized: a second
   * live build that opens a root the first holds is refused at open
   * (`holdProcessRoot`), since both would own its runs.
   */
  static layer({
    platform,
    plugins,
  }: Composition): Layer.Layer<Sessions, PluginsRefused> {
    // The list is checked before anything is composed, so a refusal names
    // the plugin rather than failing the first session open, and leaves the
    // process untouched. Then the first-install tool switches are seeded, as
    // every host's bootstrap seeds them, before the process's catalog first
    // reads them: the opt-in plugins stay off until the embedder switches
    // them on. A store that cannot be read or written is a platform defect.
    // The process layer is built only then.
    return Layer.unwrap(
      Effect.try({
        try: () => toolTable(plugins),
        catch: (thrown) =>
          new PluginsRefused({ message: toErrorMessage(thrown) }),
      }).pipe(
        Effect.tap(() =>
          seedDisabledToolDefaults(platform.roots.globalState, plugins).pipe(
            Effect.orDie,
          ),
        ),
        Effect.map(() =>
          sessionsLayer({
            storageRoot: platform.roots.storageRoot,
            plugins,
            secrets: Secrets.layer(platform.secrets),
            appState: AppState.layer(platform.roots.globalState),
            agentDirectories: AgentDirectories.layer(platform.agentDirectories),
            toolMissingReporter: platform.toolMissingHandler,
            // An embedder's console has no live level filter of its own, so
            // the package speaks at the informational level, not flooding it.
            minimumLogLevel: 'Info',
          }),
        ),
      ),
    );
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
 */
export function processLayer(
  options: ProcessLayerOptions,
): Layer.Layer<ProcessServices | Sessions> {
  return Layer.merge(
    sessionsLayer(options),
    Layer.effectDiscard(Effect.sync(installProcessHttpDispatcher)),
  );
}

function sessionsLayer(
  options: ProcessLayerOptions,
): Layer.Layer<ProcessServices | Sessions> {
  return Layer.effect(
    Sessions,
    Effect.gen(function* () {
      return yield* makeSessions(
        yield* SessionOwner,
        yield* Effect.context<ProcessServices>(),
        yield* Effect.scope,
      );
    }),
  ).pipe(Layer.provideMerge(ownerProcessLayer(options)));
}
