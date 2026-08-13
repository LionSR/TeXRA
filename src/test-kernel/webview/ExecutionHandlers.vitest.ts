// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  prepareMainViewExecutionLaunch: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  pathToLocation: vi.fn((absolutePath: string) => ({
    kind: 'external' as const,
    absolutePath,
  })),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: mocks.executeCommand },
  workspace: {},
  window: {
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: vi.fn(),
  },
}));

vi.mock('@auth/constants', () => ({
  AUTH_COMMANDS: { SIGN_IN: 'texra.auth.signIn' },
}));
vi.mock('@common/teams/TeamPlan', () => ({
  formatPartialTeamLaunchMessage: vi.fn(),
  formatTeamLaunchBlockedMessage: vi.fn(),
  formatTeamUnavailableMessage: vi.fn(),
  formatUnavailableTeamMembersMessage: vi.fn(),
  formatUnknownTeamMessage: vi.fn(),
  resolveTeamLaunch: vi.fn(),
  TEAM_LAUNCH_CANCEL_LABEL: 'Cancel',
  TEAM_LAUNCH_CONTINUE_LABEL: 'Continue',
  TEAM_LAUNCH_SIGN_IN_LABEL: 'Sign in',
  TEAM_SELECTION_REQUIRED_MESSAGE: 'Select a team',
}));
vi.mock('@controllers/mainView/teamCatalogPorts', () => ({
  createTeamCatalogPorts: vi.fn(),
}));
vi.mock('@controllers/mainView/MainViewExecutionController', () => ({
  prepareMainViewExecutionRequest: vi.fn(),
  prepareMainViewTeamExecutionRequest: vi.fn(),
}));
vi.mock(
  '@controllers/mainView/backend/MainViewExecutionLaunchController',
  () => ({
    prepareMainViewExecutionLaunch: mocks.prepareMainViewExecutionLaunch,
  }),
);
vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  logErrorMessage: vi.fn(),
}));
vi.mock('@logger/logUtils', () => ({ info: vi.fn() }));
vi.mock('@utils/files/fileLocation', () => ({
  pathToLocation: mocks.pathToLocation,
}));

const { handleExecute, handleFileOperation } =
  await import('@webview/managers/executionHandlers');

describe('MainView execution handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('presents launch errors at the extension boundary', async () => {
    mocks.prepareMainViewExecutionLaunch.mockResolvedValue({
      status: 'error',
      message: 'Team launch failed',
    });

    await handleExecute({});

    expect(mocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      'Team launch failed',
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('presents launch information before executing the prepared request', async () => {
    const request = { agentName: 'team-root' };
    mocks.prepareMainViewExecutionLaunch.mockResolvedValue({
      status: 'prepared',
      preparation: { valid: true, request },
      infoMessage: 'Continuing without writer',
    });

    await handleExecute({});

    expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
      'Continuing without writer',
    );
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith(
      'texra.execute',
      request,
    );
  });

  it.each([
    MAIN_VIEW_COMMANDS.COMPARE,
    MAIN_VIEW_COMMANDS.ACCEPT_EDITED,
  ] as const)('converts %s paths to canonical file locations', (command) => {
    handleFileOperation({
      command,
      baseFile: '/workspace/main.tex',
      editedFile: '/tmp/edited.tex',
    });

    expect(mocks.pathToLocation.mock.calls).toEqual([
      ['/workspace/main.tex'],
      ['/workspace/main.tex'],
      ['/tmp/edited.tex'],
    ]);
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith(
      `texra.${command}`,
      { kind: 'external', absolutePath: '/workspace/main.tex' },
      { kind: 'external', absolutePath: '/workspace/main.tex' },
      { kind: 'external', absolutePath: '/tmp/edited.tex' },
    );
  });
});
