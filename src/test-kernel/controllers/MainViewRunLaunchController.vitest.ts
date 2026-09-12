// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentCategory } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { LaunchSurfaceSchema } from '@shared/session/surface';

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
    showInfoMessage: vi.fn(),
    chooseTeamAvailability: vi.fn(async () => 'continue' as const),
    signInForRemoteAgentCatalog: vi.fn(async () => true),
  };
}

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
  return Effect.runPromise(
    prepareSurfaceLaunch(
      launchRequest({ launchTarget: 'team', selectedTeamId: teamId }),
      host,
    ),
  );
}

describe('main-view run launch controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prepares ordinary launches without loading the team catalog', async () => {
    const { config } = await Effect.runPromise(
      prepareSurfaceLaunch(
        launchRequest({ agent: { toolUse: 'orchestrator' } }),
        createHost(),
      ),
    );

    expect(config).toMatchObject({
      agent: 'orchestrator',
      agentCategory: AgentCategory.ToolUse,
      instruction: 'Improve the draft.',
      outputFiles: [],
    });
    expect(mocks.resolveTeamLaunch).not.toHaveBeenCalled();
  });

  it('keeps missing selections explicit before schema prefaults apply', async () => {
    await expect(
      Effect.runPromise(
        prepareSurfaceLaunch(launchRequest({ model: '' }), createHost()),
      ),
    ).rejects.toMatchObject({
      _tag: 'Rejected',
      reason: 'Choose an agent, a model, and a run type first.',
    });
  });

  it('requires an input file for workflow runs', async () => {
    await expect(
      Effect.runPromise(
        prepareSurfaceLaunch(
          launchRequest({ sessionType: 'workflow' }),
          createHost(),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: 'Rejected',
      reason: 'Choose an input file first.',
      docsCommand: 'file-management',
    });
  });

  it('rejects a team launch without a selected team', async () => {
    const host = createHost();

    await expect(launchTeam(host, '')).rejects.toMatchObject({
      _tag: 'Rejected',
      reason: 'Select a team',
    });
    expect(mocks.resolveTeamLaunch).not.toHaveBeenCalled();
  });

  it.each([
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
  ])(
    'returns $resolution.status team failures',
    async ({ resolution, expected }) => {
      const host = createHost();
      mocks.resolveTeamLaunch.mockReturnValue(Effect.succeed(resolution));

      await expect(launchTeam(host)).rejects.toMatchObject({
        _tag: 'Rejected',
        reason: expected,
      });
    },
  );

  it('returns without presenting an error when team launch is cancelled', async () => {
    const host = createHost();
    mocks.resolveTeamLaunch.mockReturnValue(
      Effect.succeed({ status: 'cancelled' }),
    );

    await expect(launchTeam(host)).rejects.toMatchObject({ _tag: 'Cancelled' });
  });

  it('returns partial membership and builds the resolved team fields', async () => {
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
    const { config } = await Effect.runPromise(
      prepareSurfaceLaunch(
        launchRequest({
          launchTarget: 'team',
          selectedTeamId: 'physicist',
          agent: { toolUse: 'stale-renderer-agent' },
        }),
        host,
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
    expect(host.showInfoMessage).toHaveBeenCalledWith('Partial: writer');
    expect(mocks.resolveTeamLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'physicist',
        catalog: true,
        choose: expect.any(Function),
        signIn: expect.any(Function),
      }),
    );
    const launchPorts = mocks.resolveTeamLaunch.mock.calls[0]![0];
    await expect(launchPorts.choose(['writer'])).resolves.toBe('continue');
    await expect(launchPorts.signIn()).resolves.toBe(true);
    expect(host.chooseTeamAvailability).toHaveBeenCalledWith(['writer']);
    expect(host.signInForRemoteAgentCatalog).toHaveBeenCalledOnce();
  });

  it('surfaces catalog errors as a launch error', async () => {
    const host = createHost();
    mocks.resolveTeamLaunch.mockReturnValue(
      Effect.fail(new Error('catalog unavailable')),
    );

    await expect(launchTeam(host)).rejects.toMatchObject({
      _tag: 'Rejected',
      reason: 'Team launch failed: catalog unavailable',
    });
  });
});
