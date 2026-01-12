// Third-party imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - common
import { showLoggedErrorMessage } from '@common/errors';
import { BaseViewMessageHandler, type MessageHandler } from '@common/webview';
import { AgentHistoryManager, type AgentHistoryItem } from '@common/history';

// Local imports - memory utilities
import {
  MEMORY_STORAGE_ROOT,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
  shouldSkipEntry,
} from '@tools/memory/constants';
import {
  relativeToDisplayPath,
  resolveMemoryStoragePath,
} from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';
import {
  getToolUseMemoryEnabled,
  setToolUseMemoryEnabled,
} from '@utils/config/constants';

// Local imports - agent
import {
  getWorkflowAgents,
  getToolUseAgents,
  loadAgents,
  type AgentEntry,
} from '@agent/index';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';

// Local imports - model
import { MODEL_CONFIGS } from '@model/ModelRegistry';

// Local imports - auth
import { SupabaseClient } from '@auth/SupabaseClient';
import { AUTH_COMMANDS } from '@auth/authCommands';
import { getServerSideKeyService } from '@auth/serverKeys';
import { ULTRA_TIER, MAX_TIER } from '@auth/config';

// Local imports - utils
import { getConfig, updateConfig } from '@utils/config';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import { HistoryIdMessageSchema } from '@webview/types/messages';

// Local imports - settings view
import {
  SETTINGS_VIEW_COMMANDS,
  type SettingsTab,
  type InitialData,
  type ModelDisplayData,
  type ProviderDisplayData,
  type AgentDisplayData,
  type AccountData,
  type LatexSettings,
  type HistoryItem,
  type ProviderStatus,
  type ProviderId,
  SaveEnabledModelsActionSchema,
  SaveEnabledAgentsActionSchema,
  SaveSettingActionSchema,
  SetApiKeyActionSchema,
  DeleteApiKeyActionSchema,
  OpenProviderUrlActionSchema,
  BrowseFileActionSchema,
  HistoryActionSchema,
  MemoryActionSchema,
  MemoryToggleActionSchema,
  OpenAgentSourceActionSchema,
  DeleteAgentActionSchema,
  type MemoryFile,
} from './schemas';

// Provider metadata
const PROVIDER_META: Record<
  ProviderId,
  { name: string; keyUrl: string; envVar: string; defaultEndpoint: string }
> = {
  anthropic: {
    name: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    envVar: 'ANTHROPIC_API_KEY',
    defaultEndpoint: 'https://api.anthropic.com',
  },
  openai: {
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    envVar: 'OPENAI_API_KEY',
    defaultEndpoint: 'https://api.openai.com/v1',
  },
  google: {
    name: 'Google',
    keyUrl: 'https://aistudio.google.com/apikey',
    envVar: 'GOOGLE_API_KEY',
    defaultEndpoint: 'https://generativelanguage.googleapis.com',
  },
  openRouter: {
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    envVar: 'OPENROUTER_API_KEY',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
  },
  deepseek: {
    name: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    envVar: 'DEEPSEEK_API_KEY',
    defaultEndpoint: 'https://api.deepseek.com',
  },
  xai: {
    name: 'xAI (Grok)',
    keyUrl: 'https://console.x.ai',
    envVar: 'XAI_API_KEY',
    defaultEndpoint: 'https://api.x.ai/v1',
  },
  moonshot: {
    name: 'Moonshot (Kimi)',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    envVar: 'MOONSHOT_API_KEY',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
  },
  dashscope: {
    name: 'DashScope (Qwen)',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    envVar: 'DASHSCOPE_API_KEY',
    defaultEndpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
};

// Recommended models for display
const RECOMMENDED_MODELS = [
  'sonnet45T',
  'opus45T',
  'gpt52',
  'gemini3p',
  'grok4',
  'deepseekT',
  'kimi2T',
  'qwen3max',
];

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  constructor(private readonly context: vscode.ExtensionContext) {
    super('SettingsView', { trackActiveView: true });
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView | vscode.WebviewPanel>
  > {
    return {
      // Initial data
      [SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA]:
        this.handleGetInitialData.bind(this),
      [SETTINGS_VIEW_COMMANDS.TAB_CHANGED]: this.handleTabChanged.bind(this),

      // Models
      [SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_MODELS]:
        this.handleSaveEnabledModels.bind(this),
      [SETTINGS_VIEW_COMMANDS.SET_API_KEY]: this.handleSetApiKey.bind(this),
      [SETTINGS_VIEW_COMMANDS.DELETE_API_KEY]:
        this.handleDeleteApiKey.bind(this),
      [SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_URL]:
        this.handleOpenProviderUrl.bind(this),

      // Agents
      [SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_AGENTS]:
        this.handleSaveEnabledAgents.bind(this),

      // Settings
      [SETTINGS_VIEW_COMMANDS.SAVE_SETTING]: this.handleSaveSetting.bind(this),
      [SETTINGS_VIEW_COMMANDS.BROWSE_FILE]: this.handleBrowseFile.bind(this),

      // Auth
      [SETTINGS_VIEW_COMMANDS.SIGN_IN]: this.handleSignIn.bind(this),
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT]: this.handleSignOut.bind(this),

      // History
      [SETTINGS_VIEW_COMMANDS.RERUN_AGENT]: this.handleRerunAgent.bind(this),
      [SETTINGS_VIEW_COMMANDS.RESTORE_AGENT]:
        this.handleRestoreAgent.bind(this),
      [SETTINGS_VIEW_COMMANDS.DELETE_HISTORY_ITEM]:
        this.handleDeleteHistoryItem.bind(this),
      [SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY]:
        this.handleClearHistory.bind(this),

      // Memory
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE]:
        this.handleOpenMemoryFile.bind(this),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]:
        this.handleOpenMemoryFolder.bind(this),
      [SETTINGS_VIEW_COMMANDS.DELETE_MEMORY]:
        this.handleDeleteMemory.bind(this),
      [SETTINGS_VIEW_COMMANDS.REFRESH_MEMORY]:
        this.handleRefreshMemory.bind(this),
      [SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED]:
        this.handleSetMemoryEnabled.bind(this),
      // Agent actions
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_SOURCE]:
        this.handleOpenAgentSource.bind(this),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT]: this.handleDeleteAgent.bind(this),
    };
  }

  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================

  public async sendInitialData(webview: vscode.Webview): Promise<void> {
    const data = await this.collectInitialData();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SET_INITIAL_DATA,
      data,
    });
  }

  public async selectTab(
    webview: vscode.Webview,
    tab: SettingsTab,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SELECT_TAB,
      tab,
    });
  }

  // ===========================================================================
  // HANDLERS - INITIAL DATA
  // ===========================================================================

  private async handleGetInitialData(
    _message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.sendInitialData(view.webview);
  }

  private async handleTabChanged(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    // Just log for now - could refresh tab-specific data here
    this.logger.debug(this.channel, `Tab changed: ${(message as any).tab}`);
  }

  // ===========================================================================
  // HANDLERS - MODELS
  // ===========================================================================

  private async handleSaveEnabledModels(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      SaveEnabledModelsActionSchema,
      message,
      'saveEnabledModels',
      async ({ models }) => {
        await updateConfig('models', models, {
          target: vscode.ConfigurationTarget.Global,
        });
      },
    );
  }

  private async handleSetApiKey(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      SetApiKeyActionSchema,
      message,
      'setApiKey',
      async ({ provider, key }) => {
        await SecretManager.set(
          SecretManager.getApiKeySecretName(provider as ApiProvider),
          key,
        );
        // Refresh data to update provider status
        await this.sendInitialData(view.webview);
      },
    );
  }

  private async handleDeleteApiKey(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      DeleteApiKeyActionSchema,
      message,
      'deleteApiKey',
      async ({ provider }) => {
        await SecretManager.delete(
          SecretManager.getApiKeySecretName(provider as ApiProvider),
        );
        // Refresh data to update provider status
        await this.sendInitialData(view.webview);
      },
    );
  }

  private async handleOpenProviderUrl(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      OpenProviderUrlActionSchema,
      message,
      'openProviderUrl',
      async ({ provider }) => {
        const meta = PROVIDER_META[provider];
        if (meta) {
          await vscode.env.openExternal(vscode.Uri.parse(meta.keyUrl));
        }
      },
    );
  }

  // ===========================================================================
  // HANDLERS - AGENTS
  // ===========================================================================

  private async handleSaveEnabledAgents(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      SaveEnabledAgentsActionSchema,
      message,
      'saveEnabledAgents',
      async ({ agents, toolUseAgents }) => {
        await Promise.all([
          updateConfig('agents', agents, {
            target: vscode.ConfigurationTarget.Workspace,
          }),
          updateConfig('toolUseAgents', toolUseAgents, {
            target: vscode.ConfigurationTarget.Workspace,
          }),
        ]);
      },
    );
  }

  // ===========================================================================
  // HANDLERS - SETTINGS
  // ===========================================================================

  private async handleSaveSetting(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      SaveSettingActionSchema,
      message,
      'saveSetting',
      async ({ key, value, target }) => {
        const configTarget =
          target === 'global'
            ? vscode.ConfigurationTarget.Global
            : vscode.ConfigurationTarget.Workspace;
        await updateConfig(key, value, { target: configTarget });
      },
    );
  }

  private async handleBrowseFile(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      BrowseFileActionSchema,
      message,
      'browseFile',
      async ({ settingKey, dialogTitle, filters }) => {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: dialogTitle || 'Select File',
          filters: filters || { 'All Files': ['*'] },
        });

        if (result && result[0]) {
          await updateConfig(settingKey, result[0].fsPath, {
            target: vscode.ConfigurationTarget.Workspace,
          });
          // Refresh to show the new value
          await this.sendInitialData(view.webview);
        }
      },
    );
  }

  // ===========================================================================
  // HANDLERS - AUTH
  // ===========================================================================

  private async handleSignIn(
    _message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
  }

  private async handleSignOut(
    _message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
  }

  // ===========================================================================
  // HANDLERS - HISTORY
  // ===========================================================================

  private async withHistoryItem(
    message: unknown,
    operationName: string,
    action: (item: AgentHistoryItem) => Promise<void>,
  ): Promise<void> {
    await this.withValidatedMessage(
      HistoryIdMessageSchema,
      message,
      operationName,
      async ({ historyId }) => {
        try {
          const item = await AgentHistoryManager.getHistoryItemById(historyId);
          if (!item) {
            await vscode.window.showErrorMessage('History item not found');
            return;
          }
          await action(item);
        } catch (error) {
          await showLoggedErrorMessage(
            this.channel,
            `Failed to ${operationName}`,
            error,
          );
        }
      },
    );
  }

  private async handleRerunAgent(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withHistoryItem(message, 'rerunAgent', async (item) => {
      await vscode.window.showInformationMessage(
        'Rerunning agent from history',
      );
      await runExecuteCommand(item.agentConfig);
    });
  }

  private async handleRestoreAgent(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withHistoryItem(message, 'restoreAgent', async (item) => {
      const taskState = agentConfigToTaskState(item.agentConfig);
      await vscode.commands.executeCommand('texra.restoreState', taskState);
    });
  }

  private async handleDeleteHistoryItem(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      HistoryActionSchema,
      message,
      'deleteHistoryItem',
      async ({ historyId }) => {
        const deleted =
          await AgentHistoryManager.deleteHistoryItemById(historyId);
        if (deleted) {
          await this.sendHistoryData(view.webview);
        }
      },
    );
  }

  private async handleClearHistory(
    _message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    try {
      await AgentHistoryManager.clearHistory();
      await vscode.window.showInformationMessage('Agent history cleared');
      await view.webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
      });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to clear history',
        error,
      );
    }
  }

  private async sendHistoryData(webview: vscode.Webview): Promise<void> {
    const history = await this.collectHistoryData();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SET_HISTORY_DATA,
      historyItems: history,
    });
  }

  // ===========================================================================
  // HANDLERS - MEMORY
  // ===========================================================================

  private async handleOpenMemoryFile(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      MemoryActionSchema,
      message,
      'openMemoryFile',
      async ({ path }) => {
        const uri = vscode.Uri.file(path);
        await vscode.window.showTextDocument(uri);
      },
    );
  }

  private async handleDeleteMemory(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      MemoryActionSchema,
      message,
      'deleteMemory',
      async ({ path }) => {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(path));
          await this.sendInitialData(view.webview);
        } catch (error) {
          await showLoggedErrorMessage(
            this.channel,
            'Failed to delete memory file',
            error,
          );
        }
      },
    );
  }

  private async handleRefreshMemory(
    _message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.sendInitialData(view.webview);
  }

  private async handleOpenMemoryFolder(): Promise<void> {
    try {
      await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
      const absolutePath = StorageFS.fullPath(MEMORY_STORAGE_ROOT);
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(absolutePath),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory folder',
        error,
      );
    }
  }

  private async handleSetMemoryEnabled(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      MemoryToggleActionSchema,
      message,
      'setMemoryEnabled',
      async ({ enabled }) => {
        await setToolUseMemoryEnabled(enabled);
        // Confirm the update back to the webview
        await this.sendInitialData(view.webview);
      },
    );
  }

  private async handleOpenAgentSource(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      OpenAgentSourceActionSchema,
      message,
      'openAgentSource',
      async ({ agentName }) => {
        // Try custom agents directory first
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          const customPath = vscode.Uri.joinPath(
            workspaceFolders[0].uri,
            '.texra',
            'agents',
            `${agentName}.yaml`,
          );
          try {
            await vscode.workspace.fs.stat(customPath);
            await vscode.commands.executeCommand('vscode.open', customPath);
            return;
          } catch {
            // Try .yml extension
            const customPathYml = vscode.Uri.joinPath(
              workspaceFolders[0].uri,
              '.texra',
              'agents',
              `${agentName}.yml`,
            );
            try {
              await vscode.workspace.fs.stat(customPathYml);
              await vscode.commands.executeCommand(
                'vscode.open',
                customPathYml,
              );
              return;
            } catch {
              // Not found in custom directory
            }
          }
        }
        void vscode.window.showWarningMessage(
          `Agent source file not found: ${agentName}`,
        );
      },
    );
  }

  private async handleDeleteAgent(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      DeleteAgentActionSchema,
      message,
      'deleteAgent',
      async ({ agentName }) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          void vscode.window.showErrorMessage('No workspace folder open');
          return;
        }

        // Find the agent file
        const extensions = ['.yaml', '.yml'];
        let fileUri: vscode.Uri | undefined;
        for (const ext of extensions) {
          const path = vscode.Uri.joinPath(
            workspaceFolders[0].uri,
            '.texra',
            'agents',
            `${agentName}${ext}`,
          );
          try {
            await vscode.workspace.fs.stat(path);
            fileUri = path;
            break;
          } catch {
            // Try next extension
          }
        }

        if (!fileUri) {
          void vscode.window.showErrorMessage(
            `Agent file not found: ${agentName}`,
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete agent "${agentName}"?`,
          { modal: true },
          'Delete',
        );

        if (confirm === 'Delete') {
          await vscode.workspace.fs.delete(fileUri);
          void vscode.window.showInformationMessage(
            `Agent "${agentName}" deleted`,
          );
          // Refresh agent list
          await this.sendInitialData(view.webview);
        }
      },
    );
  }

  // ===========================================================================
  // DATA COLLECTION
  // ===========================================================================

  private async collectInitialData(): Promise<InitialData> {
    const [account, models, providers, agents, latexSettings, history, memory] =
      await Promise.all([
        this.collectAccountData(),
        this.collectModelsData(),
        this.collectProvidersData(),
        this.collectAgentsData(),
        this.collectLatexSettings(),
        this.collectHistoryData(),
        this.collectMemoryData(),
      ]);

    const enabledModels = getConfig<string[]>('texra.models', []);
    const enabledAgents = getConfig<string[]>('texra.agents', []);
    const enabledToolUseAgents = getConfig<string[]>('texra.toolUseAgents', []);

    return {
      account,
      models,
      enabledModels,
      providers,
      agents,
      enabledAgents,
      enabledToolUseAgents,
      latexSettings,
      memoryFiles: memory.files,
      memoryEnabled: memory.enabled,
      history,
    };
  }

  private async collectAccountData(): Promise<AccountData> {
    const isAuthenticated = await SupabaseClient.isAuthenticated();

    if (!isAuthenticated) {
      return {
        authenticated: false,
      };
    }

    const serverSideKeyService = getServerSideKeyService();
    await serverSideKeyService.canUseServerSideKeys();

    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();
    const accessExpiresAt = serverSideKeyService.getAccessExpirationDate();

    return {
      authenticated: true,
      email: user?.email || 'N/A',
      userId: user?.id || '',
      tier: authContext.tier as 'free' | 'Max' | 'Ultra',
      accessExpiration: accessExpiresAt?.toISOString(),
      useIncludedAccess: serverSideKeyService.getUseIncludedModelAccess(),
    };
  }

  private async collectModelsData(): Promise<ModelDisplayData[]> {
    const enabledModels = new Set(getConfig<string[]>('texra.models', []));
    const providerStatuses = await this.collectProviderStatuses();

    return Object.entries(MODEL_CONFIGS).map(([id, config]) => ({
      id,
      name: config.name,
      fullName: config.fullName || config.name,
      provider: config.provider,
      contextWindow: config.contextWindow || 0,
      inputPrice: config.inputPrice,
      outputPrice: config.outputPrice,
      capabilities: {
        reasoning: config.capabilities.supportsReasoning,
        vision: config.capabilities.supportsVision,
        pdf: config.capabilities.supportsNativePdf,
        audio: config.capabilities.supportsNativeAudio,
        tools: config.capabilities.supportsFunctionCalling,
        caching: config.capabilities.supportsPromptCaching,
      },
      enabled: enabledModels.has(id),
      isRecommended: RECOMMENDED_MODELS.includes(id),
      status: providerStatuses[config.provider.toLowerCase()] || 'missing',
    }));
  }

  private async collectProviderStatuses(): Promise<
    Record<string, ProviderStatus>
  > {
    const statuses: Record<string, ProviderStatus> = {};

    for (const providerId of Object.keys(PROVIDER_META) as ProviderId[]) {
      const hasKey = await SecretManager.apiKeyExists(
        providerId as ApiProvider,
      );
      if (hasKey) {
        // Check if it's from env or secret storage
        const secretKey = await SecretManager.get(
          SecretManager.getApiKeySecretName(providerId as ApiProvider),
        );
        statuses[providerId] = secretKey ? 'configured' : 'env';
      } else {
        statuses[providerId] = 'missing';
      }
    }

    return statuses;
  }

  private async collectProvidersData(): Promise<ProviderDisplayData[]> {
    const statuses = await this.collectProviderStatuses();

    return (
      Object.entries(PROVIDER_META) as [
        ProviderId,
        (typeof PROVIDER_META)[ProviderId],
      ][]
    ).map(([id, meta]) => {
      // Count models for this provider
      const modelCount = Object.values(MODEL_CONFIGS).filter(
        (m) => m.provider.toLowerCase() === id,
      ).length;

      // Get streaming setting
      const streamingKey = `model.useStreaming${id.charAt(0).toUpperCase() + id.slice(1)}`;
      const streamingEnabled = getConfig<boolean>(
        `texra.${streamingKey}`,
        true,
      );

      return {
        id,
        name: meta.name,
        status: statuses[id] || 'missing',
        modelCount,
        keyUrl: meta.keyUrl,
        envVar: meta.envVar,
        streamingEnabled,
      };
    });
  }

  private async collectAgentsData(): Promise<AgentDisplayData[]> {
    await loadAgents();

    const workflowAgents = getWorkflowAgents();
    const toolUseAgents = getToolUseAgents();
    const allAgents = [...workflowAgents, ...toolUseAgents];

    const enabledWorkflow = new Set(getConfig<string[]>('texra.agents', []));
    const enabledToolUse = new Set(
      getConfig<string[]>('texra.toolUseAgents', []),
    );

    return allAgents.map((entry: AgentEntry) => ({
      name: entry.name,
      source: entry.source,
      category:
        entry.category === AgentCategory.ToolUse ? 'toolUse' : 'workflow',
      agentType: this.mapAgentType(entry.agentType),
      description: entry.description,
      enabled:
        entry.category === AgentCategory.ToolUse
          ? enabledToolUse.has(entry.name)
          : enabledWorkflow.has(entry.name),
    }));
  }

  private mapAgentType(
    agentType: AgentType,
  ): 'CoT' | 'direct' | 'toolUse' | 'merge' | 'reflect' {
    switch (agentType) {
      case AgentType.Direct:
        return 'direct';
      case AgentType.ToolUse:
        return 'toolUse';
      default:
        return 'CoT';
    }
  }

  private collectLatexSettings(): LatexSettings {
    return {
      formatter: getConfig<'latexindent' | 'tex-fmt' | 'none'>(
        'texra.latex.formatter',
        'latexindent',
      ),
      latexindentConfig: getConfig<string>('texra.latex.latexindentConfig', ''),
      texfmtConfig: getConfig<string>('texra.latex.texfmtConfig', ''),
      showLatexindentWarning: getConfig<boolean>(
        'texra.latex.showLatexindentWarning',
        true,
      ),
      latexdiffMathMarkup: getConfig<'off' | 'whole' | 'coarse' | 'fine'>(
        'texra.latexdiff.mathMarkup',
        'fine',
      ),
      latexdiffTimeoutMs: getConfig<number>('texra.latexdiff.timeoutMs', 30000),
      latexdiffPictureEnvironments: getConfig<string>(
        'texra.latexdiff.pictureEnvironments',
        '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*',
      ),
      latexdiffGenerateBetweenRoundDiffs: getConfig<boolean>(
        'texra.latexdiff.generateBetweenRoundDiffs',
        false,
      ),
      tikzInputDirectory: getConfig<string>(
        'texra.latex.tikzInputDirectory',
        '',
      ),
      includeWorkspaceInTexinputs: getConfig<boolean>(
        'texra.latex.includeWorkspaceInTexinputs',
        true,
      ),
      tikzTemplate: getConfig<string>('texra.latex.tikzTemplate', ''),
      wrapCritiqueInAlign: getConfig<boolean>(
        'texra.latex.wrapCritiqueInAlign',
        true,
      ),
      enabledReplacements: getConfig<string[]>(
        'texra.latex.enabledReplacements',
        [],
      ),
      enabledReplacementsRegex: getConfig<string[]>(
        'texra.latex.enabledReplacementsRegex',
        [],
      ),
    };
  }

  private async collectHistoryData(): Promise<HistoryItem[]> {
    const history = await AgentHistoryManager.getHistory();

    return history.map((item) => {
      const config = item.agentConfig;
      const sessionKind =
        config.session?.agentCategory === AgentCategory.ToolUse
          ? 'tool-use'
          : 'workflow';

      return {
        id: item.id,
        timestamp: item.timestamp,
        agentName: config.agent,
        modelName: config.model,
        inputFile: config.inputFile,
        inputFiles: config.inputFiles,
        outputFiles: config.outputFiles,
        referenceFile: config.referenceFile,
        referenceFiles: config.referenceFiles,
        auxiliaryFile: config.auxiliaryFile,
        auxiliaryFiles: config.auxiliaryFiles,
        mediaFile: config.mediaFile,
        mediaFiles: config.mediaFiles,
        instruction: config.instruction,
        sessionKind,
        toolConfig: config.toolConfig,
      };
    });
  }

  private async collectMemoryData(): Promise<{
    files: MemoryFile[];
    enabled: boolean;
  }> {
    const enabled = getToolUseMemoryEnabled();
    const exists = await StorageFS.exists(MEMORY_STORAGE_ROOT);

    if (!exists) {
      return { files: [], enabled };
    }

    const items = await this.walkMemoryDirectory(MEMORY_STORAGE_ROOT);
    // Sort by modification time, newest first
    items.sort((a, b) => b.modified.localeCompare(a.modified));

    return { files: items, enabled };
  }

  private async walkMemoryDirectory(
    storagePath: string,
    relativeRoot = '',
  ): Promise<MemoryFile[]> {
    const entries = await StorageFS.readDir(storagePath);
    const results: MemoryFile[] = [];

    for (const [name, type] of entries) {
      if (shouldSkipEntry(name)) {
        continue;
      }

      const nextRelative = relativeRoot ? path.join(relativeRoot, name) : name;
      const nextStoragePath = path.join(MEMORY_STORAGE_ROOT, nextRelative);

      if (type === vscode.FileType.Directory) {
        results.push(
          ...(await this.walkMemoryDirectory(nextStoragePath, nextRelative)),
        );
        continue;
      }

      const stats = await StorageFS.stat(nextStoragePath);
      const content = await StorageFS.read(nextStoragePath);
      const previewData = this.buildPreview(content);
      const displayPath = relativeToDisplayPath(nextRelative);

      results.push({
        name: displayPath,
        path: nextStoragePath,
        size: stats.size,
        modified: new Date(stats.mtime).toISOString(),
        preview: previewData.preview,
        lineCount: previewData.lineCount,
      });
    }

    return results;
  }

  private buildPreview(content: string): {
    preview: string;
    lineCount: number;
  } {
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }

    const lineCount = lines.length;
    const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
    let preview = previewLines.join('\n');
    let truncated = lineCount > MAX_PREVIEW_LINES;

    if (preview.length > MAX_PREVIEW_CHARS) {
      preview = preview.slice(0, MAX_PREVIEW_CHARS);
      truncated = true;
    }

    if (truncated) {
      preview = `${preview}\n...`;
    }

    return { preview, lineCount };
  }
}
