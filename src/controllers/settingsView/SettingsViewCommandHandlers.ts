// Shared schemas and dispatchers
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SettingsMessageFor,
  SettingsViewInboundHandlerRegistry,
  SettingsViewInboundMessage,
} from '@shared/schemas/settingsViewMessages';
import { isUnsupported, type Unsupported } from '@shared/utils/dispatcher';

const CMD = SETTINGS_VIEW_COMMANDS;

type Command = SettingsViewInboundMessage['command'];
type Message<C extends Command> = SettingsMessageFor<C>;
type Work = Promise<void> | void;
type HandlerOrUnsupported<TArgs extends readonly unknown[] = []> =
  ((...args: TArgs) => Work) | Unsupported;

type DataAction<C extends Command> = HandlerOrUnsupported<[Message<C>]>;
type EnabledAction = HandlerOrUnsupported<[boolean]>;
type StringAction = HandlerOrUnsupported<[string]>;
type StoragePathAction = HandlerOrUnsupported<[string]>;
type ProviderAction = HandlerOrUnsupported<[string]>;

export interface SettingsViewCommandActions {
  readonly lifecycle: {
    readonly webviewReady: HandlerOrUnsupported;
    readonly openVscodeSettings: HandlerOrUnsupported;
  };
  readonly memory: {
    readonly getData: HandlerOrUnsupported;
    readonly getPreview: StoragePathAction;
    readonly openFile: DataAction<typeof CMD.OPEN_MEMORY_FILE>;
    readonly openFolder: DataAction<typeof CMD.OPEN_MEMORY_FOLDER>;
    readonly delete: DataAction<typeof CMD.DELETE_MEMORY>;
    readonly setEnabled: EnabledAction;
    readonly pin: StoragePathAction;
    readonly unpin: StoragePathAction;
  };
  readonly history: {
    readonly rerunAgent: DataAction<typeof CMD.RERUN_AGENT>;
    readonly restoreAgent: DataAction<typeof CMD.RESTORE_AGENT>;
    readonly deleteAgent: HandlerOrUnsupported<[string]>;
    readonly clear: HandlerOrUnsupported;
    readonly exportChatMd: DataAction<typeof CMD.EXPORT_CHAT_MD>;
    readonly exportChatTex: DataAction<typeof CMD.EXPORT_CHAT_TEX>;
    readonly exportChatHtml: DataAction<typeof CMD.EXPORT_CHAT_HTML>;
  };
  readonly profile: {
    readonly signIn: HandlerOrUnsupported;
    readonly signOut: HandlerOrUnsupported;
    readonly setApiAccessMode: HandlerOrUnsupported<
      [Message<typeof CMD.SET_API_ACCESS_MODE>['mode']]
    >;
    readonly setProviderKey: HandlerOrUnsupported<
      [
        Message<typeof CMD.SET_PROVIDER_KEY>['provider'],
        Message<typeof CMD.SET_PROVIDER_KEY>['apiKey'],
      ]
    >;
    readonly removeProviderKey: ProviderAction;
    readonly openProviderKeyUrl: ProviderAction;
    readonly setProviderStreaming: HandlerOrUnsupported<
      [Message<typeof CMD.SET_PROVIDER_STREAMING>['provider'], boolean]
    >;
    readonly setProviderEndpoint: HandlerOrUnsupported<
      [
        Message<typeof CMD.SET_PROVIDER_ENDPOINT>['provider'],
        Message<typeof CMD.SET_PROVIDER_ENDPOINT>['endpoint'],
      ]
    >;
    readonly setGlobalStreaming: EnabledAction;
    readonly setProviderVscodeSetting: DataAction<
      typeof CMD.SET_PROVIDER_VSCODE_SETTING
    >;
    readonly openExternalUrl: StringAction;
  };
  readonly modelSelection: {
    readonly setEnabled: HandlerOrUnsupported<
      [Message<typeof CMD.SET_MODEL_ENABLED>['modelName'], boolean]
    >;
    readonly setHelperModel: StringAction;
    readonly setReasoningLevel: HandlerOrUnsupported<
      [
        Message<typeof CMD.SET_MODEL_REASONING_LEVEL>['modelName'],
        Message<typeof CMD.SET_MODEL_REASONING_LEVEL>['level'],
      ]
    >;
    readonly setPreferShortModelNames: EnabledAction;
    readonly requestAccess: StringAction;
  };
  readonly orchestration: {
    readonly setAllowOrchestratorKill: EnabledAction;
    readonly setDetachSubagentsOnStop: EnabledAction;
  };
  readonly agentSelection: {
    readonly setEnabled: HandlerOrUnsupported<
      [
        {
          category: Message<typeof CMD.SET_AGENT_ENABLED>['category'];
          source: Message<typeof CMD.SET_AGENT_ENABLED>['agentSource'];
          name: Message<typeof CMD.SET_AGENT_ENABLED>['agentName'];
          enabled: boolean;
        },
      ]
    >;
    readonly setAllEnabled: HandlerOrUnsupported<
      [
        {
          category: Message<typeof CMD.SET_ALL_AGENTS_ENABLED>['category'];
          source: Message<typeof CMD.SET_ALL_AGENTS_ENABLED>['source'];
          enabled: boolean;
        },
      ]
    >;
    readonly openYaml: HandlerOrUnsupported<
      [
        {
          source: Message<typeof CMD.OPEN_AGENT_YAML>['agentSource'];
          name: Message<typeof CMD.OPEN_AGENT_YAML>['agentName'];
        },
      ]
    >;
    readonly openFolder: DataAction<typeof CMD.OPEN_AGENT_FOLDER>;
    readonly create: DataAction<typeof CMD.CREATE_AGENT>;
    readonly customize: DataAction<typeof CMD.CUSTOMIZE_AGENT>;
    readonly deleteCustom: DataAction<typeof CMD.DELETE_CUSTOM_AGENT>;
    readonly revealFile: HandlerOrUnsupported<
      [
        {
          source: Message<typeof CMD.REVEAL_AGENT_FILE>['agentSource'];
          name: Message<typeof CMD.REVEAL_AGENT_FILE>['agentName'];
        },
      ]
    >;
    readonly viewRemotePrompt: DataAction<typeof CMD.VIEW_REMOTE_AGENT_PROMPT>;
    readonly setCustomDir: HandlerOrUnsupported;
    readonly resetCustomDir: HandlerOrUnsupported;
    readonly applyModePreset: StringAction;
    readonly saveModePreset: HandlerOrUnsupported;
    readonly deleteModePreset: StringAction;
  };
  readonly gitAuthor: {
    readonly setMarkCommits: EnabledAction;
    readonly setName: StringAction;
    readonly setEmail: StringAction;
    readonly setWorktreeSupport: EnabledAction;
  };
  readonly githubSubscriptions: {
    readonly getTokenStatus: HandlerOrUnsupported;
    readonly setToken: HandlerOrUnsupported;
    readonly removeToken: HandlerOrUnsupported;
    readonly openTokenUrl: HandlerOrUnsupported;
    readonly getSubscriptions: HandlerOrUnsupported;
    readonly unsubscribe: DataAction<typeof CMD.UNSUBSCRIBE_PR>;
    readonly openSubscriptionStream: DataAction<
      typeof CMD.OPEN_PR_SUBSCRIPTION_STREAM
    >;
  };
  readonly chatGpt: {
    readonly signIn: HandlerOrUnsupported;
    readonly signOut: HandlerOrUnsupported;
    readonly setPreferSubscription: EnabledAction;
    readonly setSubscriptionToolUseOnly: EnabledAction;
  };
  readonly approval: {
    readonly setBashApprovalEnabled: EnabledAction;
    readonly setCodexSandboxMode: StringAction;
    readonly setCodexReasoningEffort: StringAction;
    readonly setCodexApprovalPolicy: StringAction;
    readonly setClaudeAgentModel: StringAction;
    readonly setClaudeAgentPermissionMode: StringAction;
    readonly setClaudeAgentEffort: StringAction;
  };
  readonly tools: {
    readonly openInstallUrl: StringAction;
    readonly installExtension: StringAction;
    readonly recheckStatus: HandlerOrUnsupported;
    readonly toggle: HandlerOrUnsupported<
      [Message<typeof CMD.TOGGLE_TOOL>['toolId'], boolean]
    >;
    readonly runCommand: HandlerOrUnsupported<
      [
        {
          toolId: Message<typeof CMD.RUN_TOOL_COMMAND>['toolId'];
          kind: Message<typeof CMD.RUN_TOOL_COMMAND>['kind'];
        },
      ]
    >;
  };
  readonly latex: {
    readonly applySettings: DataAction<typeof CMD.APPLY_LATEX_SETTINGS>;
    readonly installLatexWorkshop: HandlerOrUnsupported;
    readonly runInstallCommand: StringAction;
    readonly setConfigValue: HandlerOrUnsupported<
      [
        {
          field: Message<typeof CMD.SET_LATEX_CONFIG_VALUE>['field'];
          value: Message<typeof CMD.SET_LATEX_CONFIG_VALUE>['value'];
        },
      ]
    >;
  };
  readonly inlineCriticism: {
    readonly getEnabled: HandlerOrUnsupported;
    readonly setEnabled: EnabledAction;
  };
  readonly goals: {
    readonly getList: HandlerOrUnsupported;
    readonly revealStream: StringAction;
  };
  readonly desktopCrashReporting: {
    readonly get: HandlerOrUnsupported;
    readonly setEnabled: EnabledAction;
    readonly setDsn: HandlerOrUnsupported;
  };
}

function mapAction<TData, TArgs extends readonly unknown[]>(
  action: HandlerOrUnsupported<TArgs>,
  project: (data: TData) => [...TArgs],
): ((data: TData) => Work) | Unsupported {
  if (isUnsupported(action)) return action;
  return (data) => action(...project(data));
}

/**
 * Builds the exhaustive settings command table once. Hosts still own the
 * effects behind each action: posting data, prompts, IPC, VS Code commands,
 * Electron-only settings, and unsupported host capabilities stay in the host
 * adapter that supplies this action object.
 */
export function createSettingsViewCommandHandlers(
  actions: SettingsViewCommandActions,
): SettingsViewInboundHandlerRegistry {
  return {
    webviewReady: actions.lifecycle.webviewReady,
    openVscodeSettings: actions.lifecycle.openVscodeSettings,
    getMemoryData: actions.memory.getData,
    getMemoryPreview: mapAction(actions.memory.getPreview, (data) => [
      data.storagePath,
    ]),
    openMemoryFile: mapAction(actions.memory.openFile, (data) => [data]),
    openMemoryFolder: actions.memory.openFolder,
    deleteMemory: mapAction(actions.memory.delete, (data) => [data]),
    setMemoryEnabled: mapAction(actions.memory.setEnabled, (data) => [
      data.enabled,
    ]),
    pinMemory: mapAction(actions.memory.pin, (data) => [data.storagePath]),
    unpinMemory: mapAction(actions.memory.unpin, (data) => [data.storagePath]),

    rerunAgent: mapAction(actions.history.rerunAgent, (data) => [data]),
    restoreAgent: mapAction(actions.history.restoreAgent, (data) => [data]),
    deleteAgent: mapAction(actions.history.deleteAgent, (data) => [
      data.historyId,
    ]),
    clearHistory: actions.history.clear,
    exportChatMd: mapAction(actions.history.exportChatMd, (data) => [data]),
    exportChatTex: mapAction(actions.history.exportChatTex, (data) => [data]),
    exportChatHtml: mapAction(actions.history.exportChatHtml, (data) => [data]),

    signIn: actions.profile.signIn,
    signOut: actions.profile.signOut,
    setApiAccessMode: mapAction(actions.profile.setApiAccessMode, (data) => [
      data.mode,
    ]),
    setProviderKey: mapAction(actions.profile.setProviderKey, (data) => [
      data.provider,
      data.apiKey,
    ]),
    removeProviderKey: mapAction(actions.profile.removeProviderKey, (data) => [
      data.provider,
    ]),
    openProviderKeyUrl: mapAction(
      actions.profile.openProviderKeyUrl,
      (data) => [data.provider],
    ),
    setProviderStreaming: mapAction(
      actions.profile.setProviderStreaming,
      (data) => [data.provider, data.enabled],
    ),
    setProviderEndpoint: mapAction(
      actions.profile.setProviderEndpoint,
      (data) => [data.provider, data.endpoint],
    ),
    setGlobalStreaming: mapAction(
      actions.profile.setGlobalStreaming,
      (data) => [data.enabled],
    ),
    setProviderVscodeSetting: mapAction(
      actions.profile.setProviderVscodeSetting,
      (data) => [data],
    ),
    openExternalUrl: mapAction(actions.profile.openExternalUrl, (data) => [
      data.url,
    ]),

    setModelEnabled: mapAction(actions.modelSelection.setEnabled, (data) => [
      data.modelName,
      data.enabled,
    ]),
    setPolishModel: mapAction(actions.modelSelection.setHelperModel, (data) => [
      data.modelName,
    ]),
    setModelReasoningLevel: mapAction(
      actions.modelSelection.setReasoningLevel,
      (data) => [data.modelName, data.level],
    ),
    setPreferShortModelNames: mapAction(
      actions.modelSelection.setPreferShortModelNames,
      (data) => [data.enabled],
    ),
    requestModelAccess: mapAction(
      actions.modelSelection.requestAccess,
      (data) => [data.modelName],
    ),

    setAllowOrchestratorKill: mapAction(
      actions.orchestration.setAllowOrchestratorKill,
      (data) => [data.enabled],
    ),
    setDetachSubagentsOnStop: mapAction(
      actions.orchestration.setDetachSubagentsOnStop,
      (data) => [data.enabled],
    ),

    setAgentEnabled: mapAction(actions.agentSelection.setEnabled, (data) => [
      {
        category: data.category,
        source: data.agentSource,
        name: data.agentName,
        enabled: data.enabled,
      },
    ]),
    setAllAgentsEnabled: mapAction(
      actions.agentSelection.setAllEnabled,
      (data) => [
        {
          category: data.category,
          source: data.source,
          enabled: data.enabled,
        },
      ],
    ),
    openAgentYaml: mapAction(actions.agentSelection.openYaml, (data) => [
      { source: data.agentSource, name: data.agentName },
    ]),
    openAgentFolder: mapAction(actions.agentSelection.openFolder, (data) => [
      data,
    ]),
    createAgent: mapAction(actions.agentSelection.create, (data) => [data]),
    customizeAgent: mapAction(actions.agentSelection.customize, (data) => [
      data,
    ]),
    deleteCustomAgent: mapAction(
      actions.agentSelection.deleteCustom,
      (data) => [data],
    ),
    revealAgentFile: mapAction(actions.agentSelection.revealFile, (data) => [
      { source: data.agentSource, name: data.agentName },
    ]),
    viewRemoteAgentPrompt: mapAction(
      actions.agentSelection.viewRemotePrompt,
      (data) => [data],
    ),
    setCustomAgentDir: actions.agentSelection.setCustomDir,
    resetCustomAgentDir: actions.agentSelection.resetCustomDir,
    applyAgentModePreset: mapAction(
      actions.agentSelection.applyModePreset,
      (data) => [data.presetId],
    ),
    saveAgentModePreset: actions.agentSelection.saveModePreset,
    deleteAgentModePreset: mapAction(
      actions.agentSelection.deleteModePreset,
      (data) => [data.presetId],
    ),

    setGitMarkCommits: mapAction(actions.gitAuthor.setMarkCommits, (data) => [
      data.enabled,
    ]),
    setGitAuthorName: mapAction(actions.gitAuthor.setName, (data) => [
      data.name,
    ]),
    setGitAuthorEmail: mapAction(actions.gitAuthor.setEmail, (data) => [
      data.email,
    ]),
    setGitWorktreeSupport: mapAction(
      actions.gitAuthor.setWorktreeSupport,
      (data) => [data.enabled],
    ),

    getGitHubTokenStatus: actions.githubSubscriptions.getTokenStatus,
    setGitHubToken: actions.githubSubscriptions.setToken,
    removeGitHubToken: actions.githubSubscriptions.removeToken,
    openGitHubTokenUrl: actions.githubSubscriptions.openTokenUrl,
    getPRSubscriptions: actions.githubSubscriptions.getSubscriptions,
    unsubscribePR: mapAction(
      actions.githubSubscriptions.unsubscribe,
      (data) => [data],
    ),
    openPRSubscriptionStream: mapAction(
      actions.githubSubscriptions.openSubscriptionStream,
      (data) => [data],
    ),

    signInChatGpt: actions.chatGpt.signIn,
    signOutChatGpt: actions.chatGpt.signOut,
    setChatGptPreferSubscription: mapAction(
      actions.chatGpt.setPreferSubscription,
      (data) => [data.enabled],
    ),
    setChatGptSubscriptionToolUseOnly: mapAction(
      actions.chatGpt.setSubscriptionToolUseOnly,
      (data) => [data.enabled],
    ),

    setBashApprovalEnabled: mapAction(
      actions.approval.setBashApprovalEnabled,
      (data) => [data.enabled],
    ),
    setCodexSandboxMode: mapAction(
      actions.approval.setCodexSandboxMode,
      (data) => [data.mode],
    ),
    setCodexReasoningEffort: mapAction(
      actions.approval.setCodexReasoningEffort,
      (data) => [data.effort],
    ),
    setCodexApprovalPolicy: mapAction(
      actions.approval.setCodexApprovalPolicy,
      (data) => [data.policy],
    ),
    setClaudeAgentModel: mapAction(
      actions.approval.setClaudeAgentModel,
      (data) => [data.model],
    ),
    setClaudeAgentPermissionMode: mapAction(
      actions.approval.setClaudeAgentPermissionMode,
      (data) => [data.mode],
    ),
    setClaudeAgentEffort: mapAction(
      actions.approval.setClaudeAgentEffort,
      (data) => [data.effort],
    ),

    openToolInstallUrl: mapAction(actions.tools.openInstallUrl, (data) => [
      data.url,
    ]),
    installToolExtension: mapAction(actions.tools.installExtension, (data) => [
      data.extensionId,
    ]),
    recheckToolStatus: actions.tools.recheckStatus,
    toggleTool: mapAction(actions.tools.toggle, (data) => [
      data.toolId,
      data.enabled,
    ]),
    runToolCommand: mapAction(actions.tools.runCommand, (data) => [
      { toolId: data.toolId, kind: data.kind },
    ]),

    applyLatexSettings: mapAction(actions.latex.applySettings, (data) => [
      data,
    ]),
    installLatexWorkshop: actions.latex.installLatexWorkshop,
    runInstallCommand: mapAction(actions.latex.runInstallCommand, (data) => [
      data.installCommand,
    ]),
    setLatexConfigValue: mapAction(actions.latex.setConfigValue, (data) => [
      { field: data.field, value: data.value },
    ]),

    getInlineCriticismEnabled: actions.inlineCriticism.getEnabled,
    setInlineCriticismEnabled: mapAction(
      actions.inlineCriticism.setEnabled,
      (data) => [data.enabled],
    ),

    getGoalList: actions.goals.getList,
    revealGoalStream: mapAction(actions.goals.revealStream, (data) => [
      data.streamId,
    ]),

    getDesktopCrashReporting: actions.desktopCrashReporting.get,
    setDesktopCrashReportingEnabled: mapAction(
      actions.desktopCrashReporting.setEnabled,
      (data) => [data.enabled],
    ),
    setDesktopCrashReportingDsn: actions.desktopCrashReporting.setDsn,
  };
}
