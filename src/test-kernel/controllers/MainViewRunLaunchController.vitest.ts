// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { AgentDirectories } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { AgentCategory } from '@shared/schemas';
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
    ),
  );
}

const mocks = vi.hoisted(() => ({
  createTeamCatalogPorts: vi.fn(() => Effect.succeed({ catalog: true })),
  resolveTeamLaunch: vi.fn(),
}));

vi.mock('@common/teams/TeamPlan', () => ({
  formatPartialTeamLaunchMessage: (names: readonly string[]) =>
    `Partial: ${names.join(', ')}`,
  formatTeamLaunchBlockedMessage: (teamId: string, reason: string) =>
    `Blocked ${teamId}: ${reason}`,
  formatTeamUnavailableMessage: (teamId: string, names: readonly string[]) =>
    `Unavailable ${teamId}: ${names.join(', ')}`,
  formatUnknownTeamMessage: (teamId: string) => `Unknown ${teamId}`,
  resolveTeamLaunch: mocks.resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE: 'Select a team',
}));
vi.mock('@controllers/mainView/teamCatalogPorts', () => ({
  createTeamCatalogPorts: mocks.createTeamCatalogPorts,
}));

const { prepareSurfaceLaunch } =
  await import('@controllers/mainView/backend/MainViewRunLaunchController');

function createHost() {
  return {
    showInfoMessage: vi.fn(() => Effect.void),
    chooseTeamAvailability: vi.fn(() => Effect.succeed('continue' as const)),
    signInForRemoteAgentCatalog: vi.fn(() => Effect.succeed(true)),
  };
}

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
          createHost(),
          workspaceState,
          STORAGE_ROOT,
        ),
      );

      expect(config).toMatchObject({
        agent: 'orchestrator',
        agentCategory: AgentCategory.ToolUse,
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
              createHost(),
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

  it.effect('requires an input file for workflow runs', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        onGlobalStorage(
          prepareSurfaceLaunch(
            launchRequest({ sessionType: 'workflow', agent: 'correct' }),
            createHost(),
            workspaceState,
            STORAGE_ROOT,
          ),
        ),
      );

      expect(error).toMatchObject({
        _tag: 'Rejected',
        reason: 'Choose an input file first.',
        docsCommand: 'file-management',
      });
    }),
  );

  it.effect('builds the resolved team fields over the renderer agent', () =>
    Effect.gen(function* () {
      const host = createHost();
      mocks.resolveTeamLaunch.mockReturnValue(
        Effect.succeed({
          status: 'ready',
          fields: {
            agent: 'builtInToolUse:lead',
            delegationAgentScope: {
              workflow: ['builtInWorkflow:writer'],
              toolUse: ['builtInToolUse:lead'],
            },
            cli: { multiAgentPresetId: 'custom-team' },
          },
          partial: true,
          missingNames: ['writer'],
        }),
      );

      // The renderer's selected agent is ignored in favour of the team plan.
      const { config } = yield* onGlobalStorage(
        prepareSurfaceLaunch(
          launchRequest({
            launchTarget: 'team',
            selectedTeamId: 'physicist',
            agent: 'stale-renderer-agent',
          }),
          host,
          workspaceState,
          STORAGE_ROOT,
        ),
      );

      expect(config).toMatchObject({
        agent: 'builtInToolUse:lead',
        agentCategory: AgentCategory.ToolUse,
        delegationAgentScope: {
          workflow: ['builtInWorkflow:writer'],
          toolUse: ['builtInToolUse:lead'],
        },
        cli: { multiAgentPresetId: 'custom-team' },
      });
    }),
  );
});
