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
      setEnabled: action(),
      pin: action(),
      unpin: action(),
    },
    history: {
      rerunAgent: action(),
      restoreAgent: action(),
      deleteAgent: action(),
      clear: action(),
      exportChatMd: action(),
      exportChatTex: action(),
      exportChatHtml: action(),
    },
    profile: {
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
      setEnabled: action(),
      setHelperModel: action(),
      setReasoningLevel: action(),
      setPreferShortModelNames: action(),
      requestAccess: action(),
    },
    orchestration: {
      setAllowOrchestratorKill: action(),
      setDetachSubagentsOnStop: action(),
    },
    agentSelection: {
      setEnabled: action(),
      setAllEnabled: action(),
      openYaml: action(),
      openFolder: action(),
      create: action(),
      customize: action(),
      deleteCustom: action(),
      revealFile: action(),
      viewRemotePrompt: action(),
      setCustomDir: action(),
      resetCustomDir: action(),
      applyModePreset: action(),
      saveModePreset: action(),
      deleteModePreset: action(),
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
      signIn: action(),
      signOut: action(),
      setPreferSubscription: action(),
      setSubscriptionToolUseOnly: action(),
    },
    approval: {
      setBashApprovalEnabled: action(),
    },
    stateSettings: {
      update: action(),
    },
    tools: {
      openInstallUrl: action(),
      installExtension: action(),
      recheckStatus: action(),
      toggle: action(),
      runCommand: action(),
    },
    latex: {
      applySettings: action(),
      installLatexWorkshop: action(),
      runInstallCommand: action(),
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

    assertSupported(registry.requestModelAccess)({
      command: SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS,
      modelName: 'copilot:sonnet46',
    });
    expect(actions.modelSelection.requestAccess).toHaveBeenCalledWith(
      'copilot:sonnet46',
    );

    assertSupported(registry.updateStateSetting)({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      key: 'texra.codexSandboxMode',
      value: 'workspace-write',
    });
    expect(actions.stateSettings.update).toHaveBeenCalledWith(
      'texra.codexSandboxMode',
      'workspace-write',
    );
  });
});
