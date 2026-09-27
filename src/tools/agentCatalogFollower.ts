/**
 * The agent catalog follows the plugins: a plugin's bundled agents its tool
 * switch, an installed plugin's agents the install record. After a change
 * to either, written by this process or another sharing the global state
 * (`AppState.changes`), the catalog reloads and every roster view repaints
 * (`agentRosterChanged`). The one path: no writer refreshes it itself.
 *
 * It follows a host's packaged catalog, so it runs only where the agent
 * directories name a packaged resources root: an embedder, and the CLI
 * entries that load no agents and must create nothing under a possibly
 * read-only storage root (`texra clone`), get no follower. As it is built,
 * before its first reload, it registers the tool plugins' agent directories
 * under that root (`<resources>/plugins/<id>/agents`), so no load or reload
 * scans without them.
 */
import { Cause, Effect, Layer, Schedule, Stream } from 'effect';

import { installPluginAgentDirectories } from '@agent/index/BundledAgentDirectories';
import { refresh as refreshAgentCatalog } from '@agent/index/agentRegistry';
import { emitAppSignal } from '@eventBus/AppSignals';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { TOOL_PLUGINS } from '@tools/plugins';
import { toErrorMessage } from '@utils/errors/errorMessage';

export const agentCatalogFollower = Layer.effectDiscard(
  Effect.gen(function* () {
    const appState = yield* AppState;
    const { resourcesRoot } = yield* AgentDirectories;
    if (resourcesRoot === undefined || resourcesRoot === '') return;
    installPluginAgentDirectories(
      resourcesRoot,
      TOOL_PLUGINS.flatMap((plugin) =>
        plugin.agents === true ? [plugin.id] : [],
      ),
    );
    const reload = Effect.suspend(() => refreshAgentCatalog()).pipe(
      Effect.andThen(
        Effect.sync(() => emitAppSignal('agentRosterChanged', undefined)),
      ),
      // A transient read failure is tried again: 200 ms doubling, six times.
      Effect.retry({ schedule: Schedule.exponential('200 millis'), times: 6 }),
      Effect.catchCause((cause) =>
        Effect.logError(
          `The agent catalog was not reloaded after a plugin change, after seven tries; it lists the agents it had until the next change: ${toErrorMessage(Cause.squash(cause))}`,
        ),
      ),
    );
    // The first element reloads too: a write that lands between the host's
    // startup scan and the feed's first read is folded into that element.
    yield* appState
      .changes([
        GlobalStateKey.DISABLED_TOOLS,
        GlobalStateKey.INSTALLED_PLUGINS,
      ])
      .pipe(
        Stream.runForEach(() => reload),
        Effect.forkScoped,
      );
  }),
);
