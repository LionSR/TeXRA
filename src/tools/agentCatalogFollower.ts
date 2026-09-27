/**
 * The agent catalog follows the plugins: a plugin's bundled agents its tool
 * switch, an installed plugin's agents the install record. After a change
 * to either, written by this process or another sharing the global state
 * (`AppState.changes`), the catalog reloads and every roster view repaints
 * (`agentRosterChanged`). The one path: no writer refreshes it itself.
 */
import { Cause, Effect, Layer, Schedule, Stream } from 'effect';

import { refresh as refreshAgentCatalog } from '@agent/index/agentRegistry';
import { emitAppSignal } from '@eventBus/AppSignals';
import { AppState } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';

export const agentCatalogFollower = Layer.effectDiscard(
  Effect.gen(function* () {
    const appState = yield* AppState;
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
