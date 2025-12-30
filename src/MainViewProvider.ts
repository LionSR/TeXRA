// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { refresh, computeAgentOptions } from '@agent/index';

// Local imports - common
import { BaseWebviewProvider } from '@common/webview';
import { getSharedLocalResourceRoots } from '@common/webview';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { agentDirectories } from '@frontend/agents';
import { watchConfig, getConfig } from '@utils/config';
import { debounce } from '@utils/core';
import { consumePendingState } from '@common/state';
import { checkCoreDependencies } from '@utils/system/toolUtils';
import { getServerSideKeyService } from '@/auth/serverKeys';
import { computeModelOptions } from '@model/computeModelOptions';

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
  private agentWatcher: vscode.FileSystemWatcher | undefined;

  // Static flag to track if commands have been registered
  private static commandsRegistered = false;

  // Debounced refresh methods using perfect-debounce
  private debouncedRefreshAgentOptions = debounce(
    () => this.refreshAgentOptions(),
    300,
  );
  private debouncedRefreshModelOptions = debounce(
    () => this.refreshModelOptions(),
    300,
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
    // Only register commands if they haven't been registered yet
    if (!MainViewProvider.commandsRegistered) {
      // Create a promise to check if the command exists and register if it doesn't
      vscode.commands.getCommands(true).then((commands) => {
        if (!commands.includes('texra.getWebviewView')) {
          this.context.subscriptions.push(
            vscode.commands.registerCommand('texra.getWebviewView', () => {
              return this._view as vscode.WebviewView;
            }),
          );
          MainViewProvider.commandsRegistered = true;
          return true;
        }
        MainViewProvider.commandsRegistered = true;
        return false;
      });

      // Command registration is handled asynchronously
    }
  }

  private setupConfigurationWatcher() {
    // Watch for agent configuration changes - only refresh agent options
    watchConfig(
      this.context,
      ['texra.agents', 'texra.toolUseAgents'],
      () => this.debouncedRefreshAgentOptions(),
    );

    // Watch for model configuration changes - only refresh model options
    watchConfig(this.context, ['texra.models'], () =>
      this.debouncedRefreshModelOptions(),
    );

    // Watch for file configuration changes - only refresh file list
    watchConfig(this.context, ['texra.files'], () => this.refreshFiles());
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

    const agentOptions = await computeAgentOptions();
    this._view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      options: agentOptions,
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
    const modelOptions = await computeModelOptions();
    this._view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      options: modelOptions,
    });
  }

  private setupFileWatcher() {
    // Create a file system watcher for relevant file types
    const filePattern =
      '**/*.{tex,txt,md,cls,png,pdf,jpeg,jpg,svg,gif,heic,heif,webp,wav,mp3,m4a,aiff,aac,ogg,flac}';
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern);

    // Handle file changes
    this.fileWatcher.onDidCreate(() => this.refreshFiles());
    this.fileWatcher.onDidDelete(() => this.refreshFiles());

    // Dispose watcher when extension is deactivated
    this.context.subscriptions.push(this.fileWatcher);
  }

  private setupAgentWatcher() {
    // Watch for YAML changes in agent directories (custom agents)
    // This refreshes the agent dropdown when agents are added/removed/modified
    const agentPattern = '**/*.yaml';
    this.agentWatcher = vscode.workspace.createFileSystemWatcher(agentPattern);

    // Cache of agent directory paths for filtering
    let agentDirPaths: string[] = [];
    const updateAgentDirs = async () => {
      const dirs = await agentDirectories.getAllLocal();
      agentDirPaths = dirs.map((d) => d.directory);
    };
    // Initialize and refresh periodically (directories might change)
    void updateAgentDirs();

    // Check if a file path is within an agent directory
    const isAgentFile = (uri: vscode.Uri): boolean => {
      const filePath = uri.fsPath;
      return agentDirPaths.some((dir) => filePath.startsWith(dir));
    };

    // Debounced refresh - updates agent dirs and options
    const debouncedAgentFileRefresh = debounce(async () => {
      await updateAgentDirs();
      await this.refreshAgentOptions();
    }, 500);

    // Filter and debounce agent file changes
    const onAgentFileChange = (uri: vscode.Uri) => {
      if (isAgentFile(uri)) {
        void debouncedAgentFileRefresh();
      }
    };

    this.agentWatcher.onDidCreate(onAgentFileChange);
    this.agentWatcher.onDidChange(onAgentFileChange);
    this.agentWatcher.onDidDelete(onAgentFileChange);

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
            missingTools: missingTools,
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
    const state = consumePendingState();

    if (state) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state,
      });
    }
  }
}
