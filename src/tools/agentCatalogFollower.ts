/**
 * The agent catalog follows the plugins: a plugin's bundled agents its tool
 * switch, an installed plugin's agents the install record. After a change
 * to either, written by this process or another sharing the global state
 * (`AppState.changes`), the catalog reloads and every roster view repaints
 * (`agentRosterChanged`). The one path: no writer refreshes it itself.
 *
 * The layer also registers the directories of the tool plugins that ship
 * agents, before its first reload: they sit beside the packaged tool-use
 * directory (`<resources>/plugins/<id>/agents` next to
 * `<resources>/tool_use_agents`), so the agent directories it is built over
 * name them, and no reload can scan without them.
 */
import * as path from 'node:path';

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
    const directories = yield* AgentDirectories;
    // Built before the runtime runs anything, so before any catalog load.
    const toolUse = yield* Effect.exit(
      Effect.suspend(() => directories.builtInToolUse()),
    );
    if (toolUse._tag === 'Failure')
      yield* Effect.logError(
        `The tool plugins' agent directories are not registered, so their agents are not listed: ${toErrorMessage(Cause.squash(toolUse.cause))}`,
      );
    else
      installPluginAgentDirectories(
        path.dirname(toolUse.value),
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
