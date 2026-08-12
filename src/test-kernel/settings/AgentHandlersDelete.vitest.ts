import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
  ensureDir: vi.fn(async () => undefined),
  fileExists: vi.fn(async () => false),
  getAgent: vi.fn(() => ({ path: '/custom/my-agent.yaml' })),
  getSourceDirectory: vi.fn(async () => undefined as string | undefined),
  refreshAfterAgentMutation: vi.fn(async () => undefined),
  showLoggedMessage: vi.fn(async () => ''),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showTextDocument: vi.fn(),
    showWarningMessage: mocks.showWarningMessage,
  },
  workspace: { openTextDocument: vi.fn() },
  Uri: { file: (path: string) => ({ fsPath: path }) },
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  loadAgents: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@agent/remote/remoteAgentConfigClient', () => ({
  fetchRemoteAgentConfigYaml: vi.fn(),
}));
vi.mock('@auth/SupabaseClient', () => ({
  SupabaseClient: { getAccessToken: vi.fn(), getUserTier: vi.fn() },
}));
vi.mock('@common/state', () => ({ globalSM: {}, workspaceSM: {} }));
vi.mock('@common/teams/TeamRosterApplication', () => ({
  applyTeamRosterWithPreflight: vi.fn(),
}));
vi.mock('@controllers/settingsView/SettingsAgentControllerFactory', () => ({
  createSettingsAgentControllers: () => ({
    catalog: {},
    directory: {},
    visibility: {},
    roster: {},
  }),
}));
vi.mock('@controllers/settingsView/SettingsAgentFileController', () => ({
  SettingsAgentFileController: class {},
}));
vi.mock(
  '@controllers/settingsView/SettingsRemoteAgentPromptController',
  () => ({
    SettingsRemoteAgentPromptController: class {},
  }),
);
vi.mock('@frontend/auth/agentCatalogRefreshScope', () => ({
  withAgentCatalogAuthRefreshDeferred: vi.fn(),
}));
vi.mock('@frontend/agents/AgentDirectoryManager', () => ({
  agentDirectories: {
    custom: vi.fn(async () => '/custom'),
    getDirectory: mocks.getSourceDirectory,
  },
}));
vi.mock('@frontend/ui/dialogs', () => ({
  confirmModal: async (message: string, actionLabel: string) => {
    const choice = await mocks.showWarningMessage(
      message,
      { modal: true },
      actionLabel,
    );
    return choice === actionLabel;
  },
}));
vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: vi.fn(),
  showLoggedMessage: mocks.showLoggedMessage,
}));
vi.mock('@shared/settingsView/handlers/agentSelectionHandlers', () => ({
  buildAgentModePresetsMessage: vi.fn(),
  buildAgentSelectionMessage: vi.fn(),
  buildCustomAgentDirMessage: vi.fn(),
}));
vi.mock('@utils/files/absoluteFS', () => ({
  AbsoluteFS: {
    copy: mocks.copyFile,
    delete: mocks.deleteFile,
    ensureDir: mocks.ensureDir,
    exists: mocks.fileExists,
  },
}));

import { AgentHandlers } from '@settingsView/handlers/agentHandlers';

function createHandlers(): AgentHandlers {
  return new AgentHandlers(
    {
      channel: 'test',
      extensionContext: {},
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      withActiveWebview: vi.fn(),
    } as never,
    mocks.refreshAfterAgentMutation,
  );
}

const DELETE_MY_AGENT = {
  command: 'deleteCustomAgent',
  agentName: 'my-agent',
} as const;

const CUSTOMIZE_MY_AGENT = {
  command: 'customizeAgent',
  agentSource: 'builtInWorkflow',
  agentName: 'my-agent',
} as const;

describe('AgentHandlers custom-agent file actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('coalesces repeated requests while the host confirmation is pending', async () => {
    let resolveConfirmation!: (choice: string | undefined) => void;
    const pendingConfirmation = new Promise<string | undefined>((resolve) => {
      resolveConfirmation = resolve;
    });
    mocks.showWarningMessage.mockReturnValueOnce(pendingConfirmation);
    const handlers = createHandlers();

    const first = handlers.handleDeleteCustomAgent(DELETE_MY_AGENT);
    await vi.waitFor(() =>
      expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1),
    );

    await handlers.handleDeleteCustomAgent(DELETE_MY_AGENT);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    resolveConfirmation(undefined);
    await first;

    mocks.showWarningMessage.mockResolvedValueOnce(undefined);
    await handlers.handleDeleteCustomAgent(DELETE_MY_AGENT);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects deletion outside the configured custom directory', async () => {
    mocks.getAgent.mockReturnValueOnce({ path: '/bundled/my-agent.yaml' });

    await createHandlers().handleDeleteCustomAgent(DELETE_MY_AGENT);

    expect(mocks.showLoggedMessage).toHaveBeenCalledWith(
      'test',
      'Refusing to delete: file is not inside the custom agents directory.',
    );
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('preserves the source-relative path when creating a custom copy', async () => {
    mocks.getAgent.mockReturnValueOnce({
      path: path.join(path.sep, 'bundled', 'writing', 'my-agent.yaml'),
    });
    mocks.getSourceDirectory.mockResolvedValueOnce(
      path.join(path.sep, 'bundled'),
    );

    await createHandlers().handleCustomizeAgent(CUSTOMIZE_MY_AGENT);

    expect(mocks.copyFile).toHaveBeenCalledWith(
      path.join(path.sep, 'bundled', 'writing', 'my-agent.yaml'),
      path.join(path.sep, 'custom', 'writing', 'my-agent.yaml'),
      { overwrite: true },
    );
    expect(mocks.refreshAfterAgentMutation).toHaveBeenCalledOnce();
  });

  it('rejects a custom-copy target outside the configured directory', async () => {
    mocks.getAgent.mockReturnValueOnce({ path: '/outside/my-agent.yaml' });
    mocks.getSourceDirectory.mockResolvedValueOnce('/bundled');

    await createHandlers().handleCustomizeAgent(CUSTOMIZE_MY_AGENT);

    expect(mocks.showLoggedMessage).toHaveBeenCalledWith(
      'test',
      'Refusing to copy: target path escapes the custom agents directory.',
    );
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });
});
