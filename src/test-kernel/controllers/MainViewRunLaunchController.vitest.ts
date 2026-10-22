// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

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

const mocks = vi.hoisted(() => ({
  createTeamCatalogPorts: vi.fn(() => Effect.succeed({ catalog: true })),
  resolveTeamLaunch: vi.fn(),
}));

vi.mock('@common/teams/TeamPlan', () => ({
  formatTeamLaunchBlockedMessage: (teamId: string, reason: string) =>
    `Blocked ${teamId}: ${reason}`,
  formatUnknownTeamMessage: (teamId: string) => `Unknown ${teamId}`,
  resolveTeamLaunch: mocks.resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE: 'Select a team',
}));
vi.mock('@texra/controllers/mainView/teamCatalogPorts', () => ({
  createTeamCatalogPorts: mocks.createTeamCatalogPorts,
}));

const { prepareSurfaceLaunch } =
  await import('@texra/controllers/mainView/backend/MainViewRunLaunchController');

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
    launch: LaunchSurfaceSchema.parse(patch),
    instruction: 'Improve the draft.',
  };
}

describe('main-view run launch controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect('prepares ordinary launches without loading the team catalog', () =>
    Effect.gen(function* () {
      const { config } = yield* onGlobalStorage(
        prepareSurfaceLaunch(launchRequest({ agent: 'orchestrator' }), ROOTS),
      );

      expect(config).toMatchObject({
        agent: 'orchestrator',
        instruction: 'Improve the draft.',
        outputFiles: [],
      });
      expect(mocks.resolveTeamLaunch).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'keeps missing selections explicit before schema prefaults apply',
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          onGlobalStorage(
            prepareSurfaceLaunch(launchRequest({ model: '' }), ROOTS),
          ),
        );

        expect(error).toMatchObject({
          _tag: 'Rejected',
          reason: 'Choose an agent and a model first.',
        });
      }),
  );

  it.effect('requires an input file for a document agent', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        onGlobalStorage(
          prepareSurfaceLaunch(launchRequest({ agent: 'correct' }), ROOTS),
        ),
      );

      expect(error).toMatchObject({
        _tag: 'Rejected',
        reason: 'Choose an input file first.',
        docsPage: 'file-management',
      });
    }),
  );

  it.effect('builds the resolved team fields over the renderer agent', () =>
    Effect.gen(function* () {
      mocks.resolveTeamLaunch.mockReturnValue({
        status: 'ready',
        fields: {
          agent: 'builtIn:lead',
          delegationAgentScope: ['builtIn:writer', 'builtIn:lead'],
          cli: { teamId: 'custom-team' },
        },
        missingNames: ['writer'],
      });

      // The renderer's selected agent is ignored in favour of the team plan.
      const { config } = yield* onGlobalStorage(
        prepareSurfaceLaunch(
          launchRequest({
            launchTarget: 'team',
            selectedTeamId: 'physicist',
            agent: 'stale-renderer-agent',
          }),
          ROOTS,
        ),
      );

      expect(config).toMatchObject({
        agent: 'builtIn:lead',
        delegationAgentScope: ['builtIn:writer', 'builtIn:lead'],
        cli: { teamId: 'custom-team' },
      });
    }),
  );
});
