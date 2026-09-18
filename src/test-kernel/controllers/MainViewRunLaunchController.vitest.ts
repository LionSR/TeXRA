// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import type { GlobalStorageFs } from '@platform/rootedFs';
import { AgentCategory } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { LaunchSurfaceSchema } from '@shared/session/surface';
import { unusedGlobalStorageFs } from '@test/support/fsTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';

/**
 * A program over the process's global storage view. Nothing under test here
 * reads it: the fake agent directories answer `custom()` themselves, so this
 * only satisfies the requirement the catalog readers name.
 */
function onGlobalStorage<A, E>(
  program: Effect.Effect<A, E, GlobalStorageFs>,
): Effect.Effect<A, E> {
  return Effect.provide(program, unusedGlobalStorageFs);
}

const mocks = vi.hoisted(() => ({
  createTeamCatalogPorts: vi.fn(() => ({ catalog: true })),
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
    chooseTeamAvailability: vi.fn(async () => 'continue' as const),
    signInForRemoteAgentCatalog: vi.fn(() => Effect.succeed(true)),
  };
}

const workspaceState = new FakeStateStore();

function launchRequest(
  patch: Record<string, unknown> = {},
): Extract<HostRequest, { kind: 'launch' }> {
  return {
    kind: 'launch',
    launch: LaunchSurfaceSchema.parse(patch),
    instruction: 'Improve the draft.',
  };
}

function launchTeam(host: ReturnType<typeof createHost>, teamId = 'physicist') {
  return onGlobalStorage(
    prepareSurfaceLaunch(
      launchRequest({ launchTarget: 'team', selectedTeamId: teamId }),
      host,
      workspaceState,
    ),
  );
}

describe('main-view run launch controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect('prepares ordinary launches without loading the team catalog', () =>
    Effect.gen(function* () {
      const { config } = yield* onGlobalStorage(
        prepareSurfaceLaunch(
          launchRequest({ agent: { toolUse: 'orchestrator' } }),
          createHost(),
          workspaceState,
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
            ),
          ),
        );

        expect(error).toMatchObject({
          _tag: 'Rejected',
          reason: 'Choose an agent, a model, and a run type first.',
        });
      }),
  );

  it.effect('requires an input file for workflow runs', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        onGlobalStorage(
          prepareSurfaceLaunch(
            launchRequest({ sessionType: 'workflow' }),
            createHost(),
            workspaceState,
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

  it.effect('rejects a team launch without a selected team', () =>
    Effect.gen(function* () {
      const host = createHost();

      const error = yield* Effect.flip(launchTeam(host, ''));

      expect(error).toMatchObject({
        _tag: 'Rejected',
        reason: 'Select a team',
      });
      expect(mocks.resolveTeamLaunch).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    {
      resolution: { status: 'unknown-team' },
      expected: 'Unknown physicist',
    },
    {
      resolution: { status: 'blocked', reason: 'no runnable root' },
      expected: 'Blocked physicist: no runnable root',
    },
    {
      resolution: {
        status: 'unavailable',
        unavailableNames: ['critic', 'writer'],
      },
      expected: 'Unavailable physicist: critic, writer',
    },
  ])('returns $resolution.status team failures', ({ resolution, expected }) =>
    Effect.gen(function* () {
      const host = createHost();
      mocks.resolveTeamLaunch.mockReturnValue(Effect.succeed(resolution));

      const error = yield* Effect.flip(launchTeam(host));

      expect(error).toMatchObject({
        _tag: 'Rejected',
        reason: expected,
      });
    }),
  );

  it.effect(
    'returns without presenting an error when team launch is cancelled',
    () =>
      Effect.gen(function* () {
        const host = createHost();
        mocks.resolveTeamLaunch.mockReturnValue(
          Effect.succeed({ status: 'cancelled' }),
        );

        const error = yield* Effect.flip(launchTeam(host));

        expect(error).toMatchObject({ _tag: 'Cancelled' });
      }),
  );

  it.effect(
    'returns partial membership and builds the resolved team fields',
    () =>
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
              agent: { toolUse: 'stale-renderer-agent' },
            }),
            host,
            workspaceState,
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
        // The partial-team notice is forked, so give the detached fiber a tick.
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        );
        expect(host.showInfoMessage).toHaveBeenCalledWith('Partial: writer');
        expect(mocks.resolveTeamLaunch).toHaveBeenCalledWith(
          expect.objectContaining({
            teamId: 'physicist',
            catalog: true,
            choose: expect.any(Function),
            signIn: expect.any(Function),
          }),
        );
        // `choose` stays Promise-shaped while `signIn` is an Effect port:
        // assert them as the caller sees them.
        const launchPorts = mocks.resolveTeamLaunch.mock.calls[0]![0] as {
          choose: (names: readonly string[]) => Promise<unknown>;
          signIn: () => Effect.Effect<boolean>;
        };
        expect(
          yield* Effect.promise(() => launchPorts.choose(['writer'])),
        ).toBe('continue');
        expect(yield* launchPorts.signIn()).toBe(true);
        expect(host.chooseTeamAvailability).toHaveBeenCalledWith(['writer']);
        expect(host.signInForRemoteAgentCatalog).toHaveBeenCalledOnce();
      }),
  );

  it.effect('surfaces catalog errors as a launch error', () =>
    Effect.gen(function* () {
      const host = createHost();
      mocks.resolveTeamLaunch.mockReturnValue(
        Effect.fail(new Error('catalog unavailable')),
      );

      const error = yield* Effect.flip(launchTeam(host));

      expect(error).toMatchObject({
        _tag: 'Rejected',
        reason: 'Team launch failed: catalog unavailable',
      });
    }),
  );
});
