import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(async () => undefined),
  getAgent: vi.fn(() => ({ path: '/custom/my-agent.yaml' })),
  planDeleteCustomAgent: vi.fn(() => ({
    ok: true as const,
    plan: { path: '/custom/my-agent.yaml' },
  })),
  refreshAfterAgentMutation: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: mocks.showInformationMessage,
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
  }),
}));
vi.mock('@controllers/settingsView/SettingsAgentFileController', () => ({
  SettingsAgentFileController: class {
    planDeleteCustomAgent = mocks.planDeleteCustomAgent;
  },
}));
vi.mock(
  '@controllers/settingsView/SettingsRemoteAgentPromptController',
  () => ({
    SettingsRemoteAgentPromptController: class {},
  }),
);
vi.mock('@frontend/agents/agentTemplateBundle', () => ({
  renderAgentTemplateFromBundle: vi.fn(),
}));
vi.mock('@frontend/auth/agentCatalogRefreshScope', () => ({
  withAgentCatalogAuthRefreshDeferred: vi.fn(),
}));
vi.mock('@frontend/agents/AgentDirectoryManager', () => ({
  agentDirectories: {
    custom: vi.fn(async () => '/custom'),
    getDirectory: vi.fn(),
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
  showLoggedMessage: vi.fn(),
}));
vi.mock('@shared/settingsView/handlers/agentSelectionHandlers', () => ({
  buildAgentModePresetsMessage: vi.fn(),
  buildAgentSelectionMessage: vi.fn(),
  buildCustomAgentDirMessage: vi.fn(),
}));
vi.mock('@utils/files', () => ({
  AbsoluteFS: { delete: mocks.deleteFile },
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

describe('AgentHandlers custom-agent deletion', () => {
  it('coalesces repeated requests while the host confirmation is pending', async () => {
    let resolveConfirmation!: (choice: string | undefined) => void;
    const pendingConfirmation = new Promise<string | undefined>((resolve) => {
      resolveConfirmation = resolve;
    });
    mocks.showWarningMessage.mockReturnValueOnce(pendingConfirmation);
    const handlers = createHandlers();
    const request = {
      command: 'deleteCustomAgent',
      agentName: 'my-agent',
    } as const;

    const first = handlers.handleDeleteCustomAgent(request);
    await vi.waitFor(() =>
      expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1),
    );

    await handlers.handleDeleteCustomAgent(request);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    resolveConfirmation(undefined);
    await first;

    mocks.showWarningMessage.mockResolvedValueOnce(undefined);
    await handlers.handleDeleteCustomAgent(request);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);
  });
});
