/**
 * The agent catalog follows the plugins: a plugin's bundled agents its tool
 * switch, an installed plugin's agents the install record. After a change
 * to either, written by this process or another sharing the global state
 * (`AppState.changes`), the catalog reloads and every roster view repaints
 * (`agentRosterChanged`). The one path: no writer refreshes it itself.
 */
import { Cause, Effect, Layer, Stream } from 'effect';

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
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `The agent catalog was not reloaded after a plugin change; it lists the agents it had: ${toErrorMessage(Cause.squash(cause))}`,
        ),
      ),
    );
    // The host loads the catalog as it starts: the first element, the
    // state as subscribed, reloads nothing.
    yield* appState
      .changes([
        GlobalStateKey.DISABLED_TOOLS,
        GlobalStateKey.INSTALLED_PLUGINS,
      ])
      .pipe(
        Stream.drop(1),
        Stream.runForEach(() => reload),
        Effect.forkScoped,
      );
  }),
);
