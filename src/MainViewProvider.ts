// Third-party imports
import * as vscode from 'vscode';

// Local imports - shared schemas
import { MainViewPersistedStateSchema } from '@shared/schemas';

// Local imports - agent
import { refresh } from '@agent/index';

// Local imports - common
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
  MAIN_VIEW_COMMANDS,
} from '@common/webview';
import { consumePendingState } from '@common/state';
import { toErrorMessage } from '@common/errors';
import { getFilterExtensions } from '@common/files/fileTypeUtils';

// Local imports - frontend
import { agentDirectories } from '@frontend/agents';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { watchConfig, getConfig, DEBOUNCE_OPTIONS_MS } from '@utils/config';
import { debounce } from '@utils/core';
import { checkCoreDependencies } from '@utils/system/toolUtils';
import { getServerSideKeyService } from '@/auth/serverKeys';

// Local file imports
import { MainViewMessageHandler } from './webview/MainViewMessageHandler';
import { MainViewContentProvider } from './webview/MainViewContentProvider';

export class MainViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.mainView';
  protected messageHandler: MainViewMessageHandler;
  protected contentProvider: MainViewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private agentWatcher: vscode.Disposable | undefined;

  // Static flag to track if commands have been registered
  private static commandsRegistered = false;

  // Debounced refresh methods using perfect-debounce
  private debouncedRefreshAgentOptions = debounce(
    this.refreshAgentOptions.bind(this),
    DEBOUNCE_OPTIONS_MS,
  );
  private debouncedRefreshModelOptions = debounce(
    this.refreshModelOptions.bind(this),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.messageHandler = new MainViewMessageHandler(context);
    this.contentProvider = new MainViewContentProvider(context);
    this.setupFileWatcher();
    this.setupAgentWatcher();
    this.setupConfigurationWatcher();
    this.setupAuthListener();
    this.registerCommandHandlers();
  }

  private registerCommandHandlers() {
    if (MainViewProvider.commandsRegistered) {
      return;
    }
    MainViewProvider.commandsRegistered = true;

    // Register command asynchronously only if it doesn't already exist
    void vscode.commands.getCommands(true).then((commands) => {
      if (!commands.includes('texra.getWebviewView')) {
        this.context.subscriptions.push(
          vscode.commands.registerCommand('texra.getWebviewView', () => {
            return this._view as vscode.WebviewView;
          }),
        );
      }
    });
  }

  private setupConfigurationWatcher() {
    // Watch for agent configuration changes - only refresh agent options
    watchConfig(
      this.context,
      ['texra.agents', 'texra.toolUseAgents', 'texra.explorer.agentsDirectory'],
      this.debouncedRefreshAgentOptions,
    );

    // Watch for model configuration changes - only refresh model options
    watchConfig(
      this.context,
      ['texra.models'],
      this.debouncedRefreshModelOptions,
    );

    // Watch for file configuration changes - only refresh file list
    watchConfig(this.context, ['texra.files'], this.refreshFiles.bind(this));
  }

  private setupAuthListener() {
    // Listen for authentication state changes to refresh model availability
    // When user logs in/out, server-side key availability may change
    this.context.subscriptions.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === 'texra-supabase') {
          void this.refreshOptionsAndView();
        }
      }),
    );

    // Listen for model access setting changes (included vs personal keys)
    this.context.subscriptions.push(
      getServerSideKeyService().onDidChangeModelAccess(() => {
        void this.refreshOptionsAndView();
      }),
    );
  }

  /**
   * Refresh both agent and model options.
   * Called when auth state changes (login/logout affects both).
   */
  async refreshOptionsAndView() {
    if (!this._view) {
      return;
    }
    // Refresh the agent index to pick up any configuration changes
    // (e.g., texra.toolUseAgents overrides)
    await refresh();

    // Send delta messages instead of regenerating entire HTML
    // This preserves webview state and avoids unnecessary DOM recreation
    await this.messageHandler.handleMessage(
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY },
      this._view as vscode.WebviewView,
    );
  }

  /**
   * Refresh agent options only.
   * Called when agent config changes (texra.agents, texra.toolUseAgents).
   */
  async refreshAgentOptions() {
    if (!this._view) {
      return;
    }
    // Refresh the agent index to pick up configuration changes
    await refresh();

    const options = await loadOptions((error) => {
      const message = toErrorMessage(error);
      void vscode.window.showErrorMessage(
        `Failed to refresh agent options: ${message}`,
      );
    });
    if (!options) return;
    const optionsData = options.agentOptions;
    this._view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData,
    });
  }

  /**
   * Refresh model options only.
   * Called when model config changes (texra.models).
   */
  async refreshModelOptions() {
    if (!this._view) {
      return;
    }
    await refresh();
    const options = await loadOptions((error) => {
      const message = toErrorMessage(error);
      void vscode.window.showErrorMessage(
        `Failed to refresh model options: ${message}`,
      );
    });
    if (!options) return;
    const optionsData = options.modelOptions;
    this._view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData,
    });
  }

  private setupFileWatcher() {
    // Create a file system watcher for relevant file types
    const allExtensions = [
      ...getFilterExtensions('input'),
      ...getFilterExtensions('reference'),
      ...getFilterExtensions('auxiliary'),
      ...getFilterExtensions('media'),
      ...getFilterExtensions('audio'),
      ...getFilterExtensions('edited'),
    ];
    const filePattern = `**/*.{${[...new Set(allExtensions)].join(',')}}`;
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern);

    // Handle file changes
    this.fileWatcher.onDidCreate(this.refreshFiles.bind(this));
    this.fileWatcher.onDidDelete(this.refreshFiles.bind(this));

    // Dispose watcher when extension is deactivated
    this.context.subscriptions.push(this.fileWatcher);
  }

  private setupAgentWatcher() {
    this.agentWatcher = agentDirectories.watchAgentDirectories({
      pattern: '**/*.yaml',
      onEvent: () => {
        this.debouncedRefreshAgentOptions();
      },
    });

    this.context.subscriptions.push(this.agentWatcher);
  }

  private async refreshFiles() {
    if (this._view) {
      await this.messageHandler.handleMessage(
        { command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES },
        this._view as vscode.WebviewView,
      );
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: getSharedLocalResourceRoots(this.context, 'webview'),
    };

    super.resolveWebviewViewInternal(webviewView);

    this.setupInitialState(webviewView);

    // Check for missing core dependencies and display banner if needed
    const showDependencyReminders = getConfig<boolean>(
      'texra.ui.showDependencyReminders',
      true,
    );
    if (showDependencyReminders) {
      checkCoreDependencies(false).then((missingTools) => {
        if (missingTools.length > 0) {
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
            missingTools,
          });
        }
      });
    }
  }

  private async setupInitialState(webviewView: vscode.WebviewView) {
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    });

    // Check if there's state to restore (consume it from pending state)
    let pendingData = consumePendingState();
    while (pendingData) {
      const parsed = MainViewPersistedStateSchema.safeParse(pendingData.state);
      if (!parsed.success) {
        console.warn('Invalid pending state restore payload', parsed.error);
        pendingData = consumePendingState();
        continue;
      }
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: parsed.data,
        executeImmediately: pendingData.executeImmediately,
      });
      pendingData = consumePendingState();
    }
  }
}
