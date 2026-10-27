// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { AgentCatalog } from '@agent/index/agentCatalog';
import { AgentDirectories, AppState } from '@platform/interfaces';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { BUNDLED_AGENTS } from '@test/support/storeFaults';
import {
  fakeHostAgentDirectories,
  storePluginsLayer,
} from '@test/support/setupPlatform';
import { LaunchSurfaceSchema } from '@texra/shared/session/surface';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import {
  launchFormOf,
  prepareSurfaceLaunch,
} from '@texra/controllers/mainView/backend/MainViewRunLaunchController';

/**
 * A program over the process's global storage view and the bundled agents:
 * a launch's agent decides its mode, so the catalog is the one a real host
 * scans. The global storage view only satisfies the requirement the catalog
 * readers name; the fake agent directories answer `custom()` themselves.
 */
function onGlobalStorage<A, E>(
  program: Effect.Effect<A, E, AgentCatalog>,
): Effect.Effect<A, E> {
  return Effect.provide(
    program,
    AgentCatalog.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          unusedGlobalStorageFs(),
          storePluginsLayer,
          nodePlatformLayer,
          testHttpClientLayer,
          AgentDirectories.layer({
            ...fakeHostAgentDirectories,
            builtIn: () => Effect.succeed(BUNDLED_AGENTS),
          }),
          AppState.layer(new FakeStateStore()),
        ),
      ),
    ),
  );
}

/** The requesting session's slots and the storage root its pasted images
 *  live under. */
const ROOTS = {
  repoState: new FakeStateStore(),
  globalState: new FakeStateStore(),
  storage: '/papers/first/.texra',
};

function launchRequest(
  patch: Record<string, unknown> = {},
): Extract<HostRequest, { kind: 'launch' }> {
  return {
    kind: 'launch',
    launch: Schema.decodeUnknownSync(LaunchSurfaceSchema)(patch),
    instruction: 'Improve the draft.',
  };
}

describe('main-view run launch controller', () => {
  it.effect(
    'fills Run again… with the agent key, model and files a form launch saved',
    () =>
      Effect.gen(function* () {
        // Failure modes: a saved key is qualified twice (`builtIn:builtIn:`),
        // or the model loses the effort the run ran at.
        const selections = {
          agent: 'builtIn:correct',
          model: 'openai/gpt-5.6-terra@high',
          inputFiles: ['/papers/first/main.tex'],
          contextFiles: ['/papers/first/refs.bib'],
        };
        const { config } = yield* onGlobalStorage(
          prepareSurfaceLaunch(launchRequest(selections), ROOTS),
        );

        expect(yield* launchFormOf(config)).toMatchObject({
          ...selections,
          launchTarget: 'agent',
          instruction: 'Improve the draft.',
        });
      }),
  );
});
