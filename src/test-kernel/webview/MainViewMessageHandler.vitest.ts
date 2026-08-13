// Standard library imports
import { setImmediate as nextTurn } from 'node:timers/promises';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - IPC contracts
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';

// Type imports
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  safeExecuteCommand: vi.fn(),
  executeCommand: vi.fn(),
  globalStateUpdate: vi.fn(),
  checkCoreDependencies: vi.fn(),
  getToolDocsCommand: vi.fn(),
  getProviderKeyUrl: vi.fn(),
  getCustomAgentDirectory: vi.fn(),
  openExternal: vi.fn(),
  parseUri: vi.fn((value: string) => ({ kind: 'parsed', value })),
  fileUri: vi.fn((value: string) => ({ kind: 'file', value })),
  workspaceFolders: [] as Array<{
    name: string;
    uri: { fsPath: string };
  }>,
}));

vi.mock('vscode', () => ({
  ColorThemeKind: { Dark: 2 },
  Uri: {
    file: mocks.fileUri,
    parse: mocks.parseUri,
  },
  commands: { executeCommand: mocks.executeCommand },
  env: { openExternal: mocks.openExternal },
  window: {
    activeColorTheme: { kind: 2 },
    showInformationMessage: vi.fn(),
  },
  workspace: {
    get workspaceFolders() {
      return mocks.workspaceFolders;
    },
  },
}));

vi.mock('@auth/constants', () => ({
  AUTH_COMMANDS: { SIGN_IN: 'texra.signIn' },
}));
vi.mock('@commands/auth/authCommands', () => ({
  getAuthStatus: vi.fn(),
}));

vi.mock('@frontend/agents/AgentDirectoryManager', () => ({
  agentDirectories: { custom: mocks.getCustomAgentDirectory },
}));

vi.mock('@frontend/agents/optionsLoader', () => ({ loadOptions: vi.fn() }));
vi.mock('@frontend/auth/codexSubscriptionSignIn', () => ({
  signInWithChatGptSubscription: vi.fn(),
}));
vi.mock('@frontend/media/RecordingManager', () => ({
  RecordingManager: class RecordingManager {},
}));
vi.mock('@frontend/system/commandUtils', () => ({
  safeExecuteCommand: mocks.safeExecuteCommand,
}));
vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: vi.fn(),
}));
vi.mock('@frontend/ui/instruction', () => ({
  showInstructionWithSuppress: vi.fn(),
}));
vi.mock('@logger/logUtils', () => ({
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  debug: vi.fn(),
  error: vi.fn(),
  isDebugModeEnabled: vi.fn(() => false),
  warn: vi.fn(),
}));
vi.mock('@shared/state/onboardingState', () => ({
  setFirstRunDone: vi.fn(),
  setOnboardingDeclined: vi.fn(),
}));
vi.mock('@utils/config/constants', () => ({}));
vi.mock('@utils/config/configUtils', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock('@common/state', async () => {
  const keys = await import('@shared/state/stateKeys');
  return { ...keys, globalSM: { update: mocks.globalStateUpdate } };
});
vi.mock('@utils/config/providerConfig', () => ({
  getProviderKeyUrl: mocks.getProviderKeyUrl,
}));
vi.mock('@utils/system/toolUtils', () => ({
  checkCoreDependencies: mocks.checkCoreDependencies,
  getToolDocsCommand: mocks.getToolDocsCommand,
}));

class ManagerStub {
  attachWebview = vi.fn();
}

vi.mock('@webview/managers/DiffManager', () => ({ DiffManager: ManagerStub }));
vi.mock('@webview/managers/FileManager', () => ({ FileManager: ManagerStub }));
vi.mock('@webview/managers/InstructionManager', () => ({
  InstructionManager: ManagerStub,
}));
vi.mock('@webview/managers/executionHandlers', () => ({
  handleExecute: vi.fn(),
  handleFileOperation: vi.fn(),
  handleHousekeeping: vi.fn(),
  handleMultipleOperation: vi.fn(),
  handleSingleOperation: vi.fn(),
}));

const { MainViewMessageHandler } =
  await import('@webview/MainViewMessageHandler');

describe('MainViewMessageHandler interaction mappings', () => {
  const postMessage = vi.fn();
  const view = { webview: { postMessage } } as unknown as vscode.WebviewView;
  let handler: InstanceType<typeof MainViewMessageHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExecuteCommand.mockResolvedValue(undefined);
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.globalStateUpdate.mockResolvedValue(undefined);
    mocks.checkCoreDependencies.mockResolvedValue([]);
    mocks.getToolDocsCommand.mockReturnValue(undefined);
    mocks.getProviderKeyUrl.mockReturnValue(undefined);
    mocks.getCustomAgentDirectory.mockResolvedValue('/agents/custom');
    mocks.openExternal.mockResolvedValue(true);
    mocks.workspaceFolders.length = 0;
    handler = new MainViewMessageHandler({
      globalState: {},
    } as unknown as vscode.ExtensionContext);
  });

  async function dispatch(message: unknown): Promise<void> {
    await handler.handleMessage(message, view);
    await nextTurn();
  }

  it('routes all four switch-view variants to their exact commands', async () => {
    await dispatch({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'dashboard',
    });
    await dispatch({ command: COMMON_COMMANDS.SWITCH_VIEW, view: 'main' });
    await dispatch({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'progress',
      openInEditor: true,
    });
    await dispatch({ command: COMMON_COMMANDS.SWITCH_VIEW, view: 'progress' });

    expect(mocks.safeExecuteCommand.mock.calls).toEqual([
      ['texra.showDashboard', [], 'MainView'],
      ['texra.showMainView', [], 'MainView'],
      ['texra.openProgressViewInTab', [], 'MainView'],
      ['texra.showProgressView', [{ inPlace: true }], 'MainView'],
    ]);
  });

  it('pushes every open workspace folder as a launcher root option', () => {
    mocks.workspaceFolders.push(
      { name: 'paper', uri: { fsPath: '/workspace/paper' } },
      { name: 'figures', uri: { fsPath: '/workspace/figures' } },
    );

    handler.postWorkspaceRoots(view);

    expect(postMessage).toHaveBeenCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_WORKSPACE_ROOTS,
      optionsData: [
        { label: 'paper', value: '/workspace/paper' },
        { label: 'figures', value: '/workspace/figures' },
      ],
    });
  });

  it('preserves extension and agent-settings arguments', async () => {
    await dispatch({ command: MAIN_VIEW_COMMANDS.SETTINGS_OPEN });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      sessionType: 'workflow',
    });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      sessionType: 'toolUse',
    });

    expect(mocks.safeExecuteCommand.mock.calls).toEqual([
      ['texra.showDashboard', [], 'MainView'],
      ['texra.showAgents', [undefined], 'MainView'],
      ['texra.showAgents', ['toolUse'], 'MainView'],
    ]);
  });

  it('opens agent settings or reveals the configured directory', async () => {
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: false,
    });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });

    expect(mocks.safeExecuteCommand).toHaveBeenCalledWith(
      'texra.showAgents',
      [],
      'MainView',
    );
    expect(mocks.getCustomAgentDirectory).toHaveBeenCalledOnce();
    expect(mocks.executeCommand).toHaveBeenCalledWith('revealFileInOS', {
      kind: 'file',
      value: '/agents/custom',
    });
  });

  it('sets a provider key only when the provider is present', async () => {
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY,
    });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY,
      provider: 'openai',
    });

    expect(mocks.safeExecuteCommand).toHaveBeenCalledOnce();
    expect(mocks.safeExecuteCommand).toHaveBeenCalledWith(
      'texra.setApiKey',
      ['openai'],
      'MainView',
    );
  });

  it('opens only resolved provider URLs and the fixed API-key guide', async () => {
    mocks.getProviderKeyUrl.mockImplementation((provider) =>
      provider === 'openai'
        ? 'https://platform.openai.com/api-keys'
        : undefined,
    );

    await dispatch({ command: MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL,
      provider: 'missing',
    });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL,
      provider: 'openai',
    });
    await dispatch({ command: MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE });

    expect(mocks.getProviderKeyUrl.mock.calls).toEqual([
      ['missing'],
      ['openai'],
    ]);
    expect(mocks.openExternal.mock.calls).toEqual([
      [
        {
          kind: 'parsed',
          value: 'https://platform.openai.com/api-keys',
        },
      ],
      [
        {
          kind: 'parsed',
          value: 'https://texra.ai/guide/installation#setting-up-api-keys',
        },
      ],
    ]);
  });

  it('ignores missing install guides and splits present commands', async () => {
    mocks.getToolDocsCommand.mockImplementation((tool) =>
      tool === 'latexindent' ? 'texra.openDoc,installation' : undefined,
    );

    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE,
      tool: 'unknown',
    });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE,
      tool: 'latexindent',
    });

    expect(mocks.safeExecuteCommand).toHaveBeenCalledOnce();
    expect(mocks.safeExecuteCommand).toHaveBeenCalledWith(
      'texra.openDoc',
      ['installation'],
      'MainView',
    );
  });

  it('hides or shows the dependency banner from the missing-tool list', async () => {
    mocks.checkCoreDependencies
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['latexindent', 'gs']);

    await dispatch({ command: MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES });
    await dispatch({ command: MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES });

    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER },
      {
        command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
        missingTools: ['latexindent', 'gs'],
      },
    ]);
  });

  it('writes the distinct dismissed-state keys for both dismissed banners', async () => {
    await dispatch({ command: MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER });
    await dispatch({
      command: MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER,
    });

    expect(mocks.globalStateUpdate.mock.calls).toEqual([
      [GlobalStateKey.LOGIN_BANNER_DISMISSED, true],
      [GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED, true],
    ]);
  });
});
