// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { MainViewExecuteMessage } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  createTeamCatalogPorts: vi.fn(() => ({ catalog: true })),
  prepareMainViewExecutionRequest: vi.fn(),
  prepareMainViewTeamExecutionRequest: vi.fn(),
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
vi.mock('@controllers/mainView/MainViewExecutionController', () => ({
  prepareMainViewExecutionRequest: mocks.prepareMainViewExecutionRequest,
  prepareMainViewTeamExecutionRequest:
    mocks.prepareMainViewTeamExecutionRequest,
}));

const { prepareMainViewExecutionLaunch } =
  await import('@controllers/mainView/MainViewExecutionLaunchController');

function createHost() {
  return {
    chooseTeamAvailability: vi.fn(async () => 'continue' as const),
    signInForRemoteAgentCatalog: vi.fn(async () => true),
    showErrorMessage: vi.fn(async () => undefined),
    showInfoMessage: vi.fn(async () => undefined),
  };
}

function teamMessage(teamId = 'physicist'): MainViewExecuteMessage {
  return {
    session: { launchTarget: 'team', teamId },
  };
}

describe('main-view execution launch controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prepares ordinary launches without loading the team catalog', async () => {
    const message: MainViewExecuteMessage = {};
    const preparation = { valid: false as const, message: 'ordinary' };
    mocks.prepareMainViewExecutionRequest.mockReturnValue(preparation);

    await expect(
      prepareMainViewExecutionLaunch(message, createHost()),
    ).resolves.toBe(preparation);
    expect(mocks.resolveTeamLaunch).not.toHaveBeenCalled();
  });

  it('rejects a team launch without a selected team', async () => {
    const host = createHost();

    await expect(
      prepareMainViewExecutionLaunch(teamMessage(''), host),
    ).resolves.toBeUndefined();
    expect(host.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      'Select a team',
    );
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
    'presents $resolution.status team failures',
    async ({ resolution, expected }) => {
      const host = createHost();
      mocks.resolveTeamLaunch.mockResolvedValue(resolution);

      await expect(
        prepareMainViewExecutionLaunch(teamMessage(), host),
      ).resolves.toBeUndefined();
      expect(host.showErrorMessage).toHaveBeenCalledExactlyOnceWith(expected);
      expect(mocks.prepareMainViewTeamExecutionRequest).not.toHaveBeenCalled();
    },
  );

  it('returns without presenting an error when team launch is cancelled', async () => {
    const host = createHost();
    mocks.resolveTeamLaunch.mockResolvedValue({ status: 'cancelled' });

    await expect(
      prepareMainViewExecutionLaunch(teamMessage(), host),
    ).resolves.toBeUndefined();
    expect(host.showErrorMessage).not.toHaveBeenCalled();
    expect(host.showInfoMessage).not.toHaveBeenCalled();
  });

  it('presents partial membership and prepares the resolved team fields', async () => {
    const host = createHost();
    const fields = {
      agent: 'team-root',
      delegationAgentScope: {
        workflowAgentKeys: ['workflow:critic'],
        toolUseAgentKeys: ['toolUse:team-root'],
      },
      cliMultiAgentPresetId: 'physicist',
    };
    const preparation = { valid: false as const, message: 'invalid model' };
    mocks.resolveTeamLaunch.mockResolvedValue({
      status: 'ready',
      fields,
      partial: true,
      missingNames: ['writer'],
    });
    mocks.prepareMainViewTeamExecutionRequest.mockReturnValue(preparation);
    const message = teamMessage();

    await expect(prepareMainViewExecutionLaunch(message, host)).resolves.toBe(
      preparation,
    );
    expect(host.showInfoMessage).toHaveBeenCalledExactlyOnceWith(
      'Partial: writer',
    );
    expect(mocks.prepareMainViewTeamExecutionRequest).toHaveBeenCalledWith(
      message,
      fields,
    );
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

  it('surfaces catalog errors and returns no preparation', async () => {
    const host = createHost();
    mocks.resolveTeamLaunch.mockRejectedValue(new Error('catalog unavailable'));

    await expect(
      prepareMainViewExecutionLaunch(teamMessage(), host),
    ).resolves.toBeUndefined();
    expect(host.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      'Team launch failed: catalog unavailable',
    );
  });
});
