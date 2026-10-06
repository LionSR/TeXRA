// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { AgentDirectories, AppState } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import type { HostRequest } from '@shared/session/hostRequest';
import { LaunchSurfaceSchema } from '@shared/session/surface';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { fakeHostAgentDirectories } from '@test/support/setupPlatform';

/**
 * A program over the process's global storage view. Nothing under test here
 * reads it: the fake agent directories answer `custom()` themselves, so this
 * only satisfies the requirement the catalog readers name.
 */
function onGlobalStorage<A, E>(
  program: Effect.Effect<A, E, AgentCatalogServices>,
): Effect.Effect<A, E> {
  return Effect.provide(
    program,
    Layer.mergeAll(
      unusedGlobalStorageFs(),
      nodePlatformLayer,
      testHttpClientLayer,
      AgentDirectories.layer(fakeHostAgentDirectories),
      AppState.layer(new FakeStateStore()),
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

const workspaceState = new FakeStateStore();

/** The requesting session's storage root, under which its pasted images live. */
const STORAGE_ROOT = '/papers/first/.texra';

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
        prepareSurfaceLaunch(
          launchRequest({ agent: 'orchestrator' }),
          workspaceState,
          STORAGE_ROOT,
        ),
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
            prepareSurfaceLaunch(
              launchRequest({ model: '' }),
              workspaceState,
              STORAGE_ROOT,
            ),
          ),
        );

        expect(error).toMatchObject({
          _tag: 'Rejected',
          reason: 'Choose an agent and a model first.',
        });
      }),
  );

  it.effect('requires an input file for document task runs', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        onGlobalStorage(
          prepareSurfaceLaunch(
            launchRequest({ sessionType: 'task', agent: 'correct' }),
            workspaceState,
            STORAGE_ROOT,
          ),
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
          workspaceState,
          STORAGE_ROOT,
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
