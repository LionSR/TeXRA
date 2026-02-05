/**
 * Schema-driven message handler for SettingsView.
 *
 * Combines handlers from MemoryView, HistoryView, and ProfileView
 * into a single unified message handler.
 */
import * as vscode from 'vscode';

// Shared schemas and dispatchers
import {
  dispatchSettingsViewInbound,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas/settingsViewMessages';
import { showLoggedErrorMessage } from '@common/errors';
import {
  AgentHistoryManager,
  type AgentHistoryItem,
} from '@common/history/AgentHistoryManager';
import {
  BaseViewMessageHandler,
  SETTINGS_VIEW_COMMANDS,
} from '@common/webview';
import { getAgentsBySource, loadAgents } from '@agent/index';
import { selectAgentInMainView } from '@agent/remote/remoteAgentUtils';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ULTRA_TIER, MAX_TIER } from '@auth/config';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { PROVIDER_URLS } from '@commands/api/apiKeyCommands';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { MEMORY_STORAGE_ROOT } from '@tools/memory/constants';
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import {
  getToolUseMemoryEnabled,
  setToolUseMemoryEnabled,
} from '@utils/config/constants';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import { StorageFS } from '@utils/files';
import { loadMemoryItems } from './utils/memoryFileSystem';
import type {
  RemoteAgent,
  ProviderKeyStatus,
} from '@shared/schemas/profileViewMessages';

// Type helper for extracting specific message types
type MessageFor<C extends SettingsViewInboundMessage['command']> = Extract<
  SettingsViewInboundMessage,
  { command: C }
>;

const PROVIDER_DISPLAY_NAMES: Record<ApiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openRouter: 'OpenRouter',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  dashscope: 'DashScope',
  wolframllmapp: 'Wolfram',
};

async function getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
  return Promise.all(
    SecretManager.API_PROVIDERS.map(async (provider) => {
      const secretValue = await SecretManager.get(
        SecretManager.getApiKeySecretName(provider),
      );
      const envValue = process.env[`${provider.toUpperCase()}_API_KEY`];

      let status: ProviderKeyStatus['status'];
      if (secretValue) {
        status = 'set';
      } else if (envValue) {
        status = 'env';
      } else {
        status = 'not-set';
      }

      return {
        provider,
        displayName: PROVIDER_DISPLAY_NAMES[provider],
        status,
        keyUrl: PROVIDER_URLS[provider],
      };
    }),
  );
}

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  constructor(_context: vscode.ExtensionContext) {
    super('SettingsView', { trackActiveView: true });
    this.handlerRegistry = this.createHandlerRegistry();
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    return {
      // Navigation handlers
      [SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS]: () =>
        this.handleOpenVscodeSettings(),

      // Memory handlers
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA]: () =>
        this.handleGetMemoryData(),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE]: (data) =>
        this.handleOpenMemoryFile(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]: () =>
        this.handleOpenMemoryFolder(),
      [SETTINGS_VIEW_COMMANDS.DELETE_MEMORY]: (data) =>
        this.handleDeleteMemory(data),
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED]: () =>
        this.handleGetMemoryEnabled(),
      [SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED]: (data) =>
        this.handleSetMemoryEnabled(data),

      // History handlers
      [SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA]: () =>
        this.handleGetHistoryData(),
      [SETTINGS_VIEW_COMMANDS.RERUN_AGENT]: (data) =>
        this.handleRerunAgent(data),
      [SETTINGS_VIEW_COMMANDS.RESTORE_AGENT]: (data) =>
        this.handleRestoreAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT]: (data) =>
        this.handleDeleteAgent(data),
      [SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY]: () => this.handleClearHistory(),

      // Profile handlers
      [SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA]: () =>
        this.handleGetProfileData(),
      [SETTINGS_VIEW_COMMANDS.SELECT_AGENT]: (data) =>
        this.handleSelectAgent(data),
      [SETTINGS_VIEW_COMMANDS.SIGN_IN]: () => this.handleSignIn(),
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT]: () => this.handleSignOut(),
      [SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE]: (data) =>
        this.handleSetApiAccessMode(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY]: (data) =>
        this.handleSetProviderKey(data),
      [SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY]: (data) =>
        this.handleRemoveProviderKey(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL]: (data) =>
        this.handleOpenProviderKeyUrl(data),
    };
  }

  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withActiveView(webviewView, async () => {
      const handled = dispatchSettingsViewInbound(
        message,
        this.handlerRegistry,
        (error) => {
          this.logger.debug(this.channel, 'Message validation failed', {
            data: error,
          });
        },
      );

      if (
        !handled &&
        message &&
        typeof message === 'object' &&
        'command' in message
      ) {
        this.logger.warn(
          this.channel,
          `Unhandled command: ${(message as { command: string }).command}`,
        );
      }
    });
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendAllData(webview: vscode.Webview): Promise<void> {
    await Promise.all([
      this.sendMemoryData(webview),
      this.sendMemoryEnabled(webview),
      this.sendHistoryData(webview),
      this.sendProfileData(webview),
    ]);
  }

  public async sendMemoryData(webview: vscode.Webview): Promise<void> {
    const items = await loadMemoryItems();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    });
  }

  public async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    const enabled = getToolUseMemoryEnabled();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled,
    });
  }

  public async sendHistoryData(webview: vscode.Webview): Promise<void> {
    const history = await AgentHistoryManager.getHistory();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: history,
    });
  }

  public async sendProfileData(webview: vscode.Webview): Promise<void> {
    const isAuthenticated = await SupabaseClient.isAuthenticated();
    const providerKeyStatuses = await getProviderKeyStatuses();

    if (!isAuthenticated) {
      await webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'personal',
        enabledProviders: [],
        allowedModels: [],
        tierConstants: {
          ultra: ULTRA_TIER,
          max: MAX_TIER,
        },
        providerKeyStatuses,
      });
      return;
    }

    const serverSideKeyService = getServerSideKeyService();
    const hasServerSideAccess =
      await serverSideKeyService.canUseServerSideKeys();

    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();

    await loadAgents();
    const remoteAgents: RemoteAgent[] = getAgentsBySource('remote').map(
      (entry) => ({
        name: entry.name,
        description: entry.description ?? '',
        visibility: entry.visibility ?? ['public'],
        category: entry.category,
        supportsMultipleOutput: Boolean(entry.multiplePath),
      }),
    );

    const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();
    const apiAccessMode = useIncludedAccess ? 'included' : 'personal';

    const enabledProviders = hasServerSideAccess
      ? serverSideKeyService.getEffectiveProvidersForCurrentUser()
      : [];
    const allowedModels = hasServerSideAccess
      ? serverSideKeyService.getAllowedModelsForCurrentUser()
      : [];

    const accessExpiresAt = serverSideKeyService.getAccessExpirationDate();

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: true,
      user: {
        email: user?.email ?? 'N/A',
        id: user?.id ?? '',
      },
      tier: authContext.tier,
      permissions: authContext.permissions,
      remoteAgents,
      apiAccessMode,
      enabledProviders,
      allowedModels,
      tierConstants: {
        ultra: ULTRA_TIER,
        max: MAX_TIER,
      },
      accessExpiresAt: accessExpiresAt?.toISOString() ?? null,
      providerKeyStatuses,
    });
  }

  // ============================================================
  // Navigation handler implementations
  // ============================================================

  private async handleOpenVscodeSettings(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:texra-ai.texra',
    );
  }

  // ============================================================
  // Memory handler implementations
  // ============================================================

  private async handleGetMemoryData(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendMemoryData(view.webview);
    }
  }

  private async handleOpenMemoryFile(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
      const doc = await vscode.workspace.openTextDocument(absolutePath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory file',
        error,
      );
    }
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

  private async handleDeleteMemory(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_MEMORY>,
  ): Promise<void> {
    const view = this.getActiveView();

    const confirm = await vscode.window.showWarningMessage(
      `Delete "${data.displayPath}"?`,
      { modal: true },
      'Delete',
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      await StorageFS.delete(resolvedPath, { recursive: true });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete memory',
        error,
      );
    } finally {
      if (view) {
        await this.sendMemoryData(view.webview);
      }
    }
  }

  private async handleGetMemoryEnabled(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendMemoryEnabled(view.webview);
    }
  }

  private async handleSetMemoryEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    const view = this.getActiveView();
    await setToolUseMemoryEnabled(data.enabled);

    if (view) {
      await this.sendMemoryEnabled(view.webview);
    }
  }

  // ============================================================
  // History handler implementations
  // ============================================================

  private async handleGetHistoryData(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendHistoryData(view.webview);
    }
  }

  private async handleRerunAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RERUN_AGENT>,
  ): Promise<void> {
    await this.withHistoryItem(
      data.historyId,
      'Failed to rerun agent',
      async (historyItem) => {
        await vscode.window.showInformationMessage(
          'Rerunning agent from history',
        );
        await runExecuteCommand(historyItem.agentConfig);
      },
    );
  }

  private async handleRestoreAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RESTORE_AGENT>,
  ): Promise<void> {
    await this.withHistoryItem(
      data.historyId,
      'Failed to restore configuration',
      async (historyItem) => {
        const taskState = agentConfigToTaskState(historyItem.agentConfig);
        await vscode.commands.executeCommand('texra.restoreState', taskState);
      },
    );
  }

  private async handleDeleteAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT>,
  ): Promise<void> {
    const view = this.getActiveView();
    try {
      const deleted = await AgentHistoryManager.deleteHistoryItemById(
        data.historyId,
      );
      if (deleted && view) {
        await this.sendHistoryData(view.webview);
      } else if (!deleted) {
        await vscode.window.showWarningMessage(
          `History item not found: ${data.historyId}`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete history item',
        error,
      );
    }
  }

  private async handleClearHistory(): Promise<void> {
    const view = this.getActiveView();
    try {
      await AgentHistoryManager.clearHistory();
      await vscode.window.showInformationMessage('Agent history cleared');
      await view?.webview.postMessage({
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

  private async withHistoryItem(
    historyId: string,
    errorPrefix: string,
    action: (historyItem: AgentHistoryItem) => Promise<void>,
  ): Promise<void> {
    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);
      if (!historyItem) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }
      await action(historyItem);
    } catch (error) {
      await showLoggedErrorMessage(this.channel, errorPrefix, error);
    }
  }

  // ============================================================
  // Profile handler implementations
  // ============================================================

  private async handleGetProfileData(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendProfileData(view.webview);
    }
  }

  private async handleSelectAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SELECT_AGENT>,
  ): Promise<void> {
    await selectAgentInMainView(data.agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: false,
    });
  }

  private async handleSignIn(): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
  }

  private async handleSignOut(): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
  }

  private async handleSetApiAccessMode(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_API_ACCESS_MODE>,
  ): Promise<void> {
    const view = this.getActiveView();

    const useIncludedAccess = data.mode === 'included';
    await getServerSideKeyService().setUseIncludedModelAccess(
      useIncludedAccess,
    );

    if (view) {
      await this.sendProfileData(view.webview);
    }

    const modeLabel =
      data.mode === 'included' ? 'Included Access' : 'My Own Keys';
    void vscode.window.showInformationMessage(
      `Model access changed to: ${modeLabel}`,
    );
  }

  private async handleSetProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_KEY>,
  ): Promise<void> {
    const provider = data.provider as ApiProvider;
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter ${displayName} API key`,
      password: true,
      placeHolder: '************************************',
    });

    if (!apiKey) {
      return;
    }

    try {
      await SecretManager.set(
        SecretManager.getApiKeySecretName(provider),
        apiKey,
      );
      void vscode.window.showInformationMessage(
        `${displayName} API key has been set`,
      );
      await this.refreshAfterKeyChange();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to set ${displayName} API key`,
        error,
      );
    } finally {
      const view = this.getActiveView();
      if (view) {
        await this.sendProfileData(view.webview);
      }
    }
  }

  private async handleRemoveProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.REMOVE_PROVIDER_KEY>,
  ): Promise<void> {
    const provider = data.provider as ApiProvider;
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

    try {
      await SecretManager.delete(SecretManager.getApiKeySecretName(provider));
      void vscode.window.showInformationMessage(
        `${displayName} API key has been removed`,
      );
      await this.refreshAfterKeyChange();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to remove ${displayName} API key`,
        error,
      );
    } finally {
      const view = this.getActiveView();
      if (view) {
        await this.sendProfileData(view.webview);
      }
    }
  }

  /** Refresh main view API key status and model options after key changes. */
  private async refreshAfterKeyChange(): Promise<void> {
    await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
    void vscode.commands.executeCommand('texra.refreshAllOptions');
  }

  private async handleOpenProviderKeyUrl(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_PROVIDER_KEY_URL>,
  ): Promise<void> {
    const provider = data.provider as ApiProvider;
    const url = PROVIDER_URLS[provider];
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }
}
