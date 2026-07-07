import { describe, expect, it, vi } from 'vitest';

import {
  createSettingsViewCommandHandlers,
  type SettingsViewCommandActions,
} from '@controllers/settingsView/SettingsViewCommandHandlers';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { SETTINGS_VIEW_CMD } from '@shared/schemas/settingsViewMessages';
import { assertSupported, unsupportedCommands } from '@shared/utils/dispatcher';

const unsupportedReason = 'not available in this host';
const NON_INBOUND_SETTINGS_COMMANDS = new Set<string>([
  SETTINGS_VIEW_CMD.SET_TAB,
  SETTINGS_VIEW_CMD.UPDATE_CHATGPT_AUTH_STATUS,
  SETTINGS_VIEW_CMD.UPDATE_DESKTOP_CRASH_REPORTING,
  SETTINGS_VIEW_CMD.UPDATE_GITHUB_TOKEN_STATUS,
  SETTINGS_VIEW_CMD.UPDATE_PR_SUBSCRIPTIONS,
]);

function action() {
  return vi.fn();
}

function createActions(): SettingsViewCommandActions {
  return {
    lifecycle: {
      webviewReady: action(),
      openVscodeSettings: { unsupported: unsupportedReason },
    },
    memory: {
      getData: action(),
      getPreview: action(),
      openFile: action(),
      openFolder: action(),
      delete: action(),
      getEnabled: action(),
      setEnabled: action(),
      pin: action(),
      unpin: action(),
    },
    history: {
      getData: action(),
      rerunAgent: action(),
      restoreAgent: action(),
      deleteAgent: action(),
      clear: action(),
      exportChatMd: action(),
      exportChatTex: action(),
      exportChatHtml: action(),
    },
    profile: {
      getData: action(),
      selectAgent: action(),
      signIn: action(),
      signOut: action(),
      setApiAccessMode: action(),
      setProviderKey: action(),
      removeProviderKey: action(),
      openProviderKeyUrl: action(),
      setProviderStreaming: action(),
      setProviderEndpoint: action(),
      setGlobalStreaming: action(),
      setProviderVscodeSetting: action(),
      openExternalUrl: action(),
    },
    modelSelection: {
      getData: action(),
      setEnabled: action(),
      setHelperModel: action(),
      setReasoningLevel: action(),
      setPreferShortModelNames: action(),
    },
    orchestration: {
      getSuperYoloEnabled: action(),
      setSuperYoloEnabled: action(),
      setAllowOrchestratorKill: action(),
      setDetachSubagentsOnStop: action(),
    },
    agentSelection: {
      getData: action(),
      setEnabled: action(),
      setAllEnabled: action(),
      openYaml: action(),
      openFolder: action(),
      create: action(),
      customize: action(),
      deleteCustom: action(),
      revealFile: action(),
      viewRemotePrompt: action(),
      getCustomDir: action(),
      setCustomDir: action(),
      resetCustomDir: action(),
      getModePresets: action(),
      applyModePreset: action(),
      saveModePreset: action(),
      deleteModePreset: action(),
    },
    gitAuthor: {
      getSettings: action(),
      setMarkCommits: action(),
      setName: action(),
      setEmail: action(),
      setWorktreeSupport: action(),
    },
    githubSubscriptions: {
      getTokenStatus: action(),
      setToken: action(),
      removeToken: action(),
      openTokenUrl: action(),
      getSubscriptions: action(),
      unsubscribe: action(),
      openSubscriptionStream: action(),
    },
    chatGpt: {
      getAuthStatus: action(),
      signIn: action(),
      signOut: action(),
      setPreferSubscription: action(),
      setSubscriptionToolUseOnly: action(),
    },
    approval: {
      getSettings: action(),
      setBashApprovalEnabled: action(),
      setCodexSandboxMode: action(),
      setCodexReasoningEffort: action(),
      setCodexApprovalPolicy: action(),
      setClaudeAgentModel: action(),
      setClaudeAgentPermissionMode: action(),
      setClaudeAgentEffort: action(),
    },
    tools: {
      getDashboardData: action(),
      openInstallUrl: action(),
      installExtension: action(),
      recheckStatus: action(),
      toggle: action(),
      runCommand: action(),
    },
    latex: {
      getSettingsStatus: action(),
      applySettings: action(),
      installLatexWorkshop: action(),
      runInstallCommand: action(),
      getConfigValues: action(),
      setConfigValue: action(),
    },
    inlineCriticism: {
      getEnabled: action(),
      setEnabled: action(),
    },
    goals: {
      getList: action(),
      revealStream: action(),
    },
    desktopCrashReporting: {
      get: { unsupported: unsupportedReason },
      setEnabled: action(),
      setDsn: action(),
    },
  };
}

describe('createSettingsViewCommandHandlers', () => {
  it('authors every settings inbound command exactly once', () => {
    const registry = createSettingsViewCommandHandlers(createActions());
    const expectedInboundCommands = [
      SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      ...Object.values(SETTINGS_VIEW_CMD).filter(
        (command) => !NON_INBOUND_SETTINGS_COMMANDS.has(command),
      ),
    ];

    expect(Object.keys(registry).toSorted()).toEqual(
      expectedInboundCommands.toSorted(),
    );
  });

  it('preserves unsupported host decisions in the derived capability set', () => {
    const registry = createSettingsViewCommandHandlers(createActions());

    expect(unsupportedCommands(registry).toSorted()).toEqual(
      [
        SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
        SETTINGS_VIEW_COMMANDS.GET_DESKTOP_CRASH_REPORTING,
      ].toSorted(),
    );
  });

  it('projects representative command payloads to semantic host actions', () => {
    const actions = createActions();
    const registry = createSettingsViewCommandHandlers(actions);

    assertSupported(registry.setProviderKey)({
      command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
      provider: 'openai',
      apiKey: 'sk-test',
    });
    expect(actions.profile.setProviderKey).toHaveBeenCalledWith(
      'openai',
      'sk-test',
    );

    assertSupported(registry.exportChatTex)({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
      historyId: 'hist-1',
    });
    expect(actions.history.exportChatTex).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
      historyId: 'hist-1',
    });

    assertSupported(registry.setAgentEnabled)({
      command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
      agentName: 'proofreader',
      agentSource: 'custom',
      category: 'toolUse',
      enabled: true,
    });
    expect(actions.agentSelection.setEnabled).toHaveBeenCalledWith({
      category: 'toolUse',
      source: 'custom',
      name: 'proofreader',
      enabled: true,
    });

    assertSupported(registry.runToolCommand)({
      command: SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
      toolId: 'latex',
      kind: 'install',
    });
    expect(actions.tools.runCommand).toHaveBeenCalledWith({
      toolId: 'latex',
      kind: 'install',
    });
  });
});
