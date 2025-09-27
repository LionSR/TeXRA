// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { BaseWebviewProvider } from '@common/webview/BaseWebviewProvider';

// Local imports - webview
import { MainViewMessageHandler } from './webview/MainViewMessageHandler';
import { MainViewContentProvider } from './webview/MainViewContentProvider';
import { watchConfig, getConfig } from '@utils/config';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { checkCoreDependencies } from '@utils/system/toolUtils';

export class MainViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  protected messageHandler: MainViewMessageHandler;
  protected contentProvider: MainViewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  // Static flag to track if commands have been registered
  private static commandsRegistered = false;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.messageHandler = new MainViewMessageHandler(context);
    this.contentProvider = new MainViewContentProvider(context);
    this.setupFileWatcher();
    this.setupConfigurationWatcher();
    this.registerCommandHandlers();
  }

  private registerCommandHandlers() {
    // Only register commands if they haven't been registered yet
    if (!MainViewProvider.commandsRegistered) {
      // Create a promise to check if the command exists and register if it doesn't
      const registerCommandPromise = vscode.commands
        .getCommands(true)
        .then((commands) => {
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

      // Log the result for diagnostics
      registerCommandPromise.then((registered) => {
        if (registered) {
          console.log('Registered texra.getWebviewView command');
        } else {
          console.log(
            'Command texra.getWebviewView already exists, skipped registration',
          );
        }
      });
    }

    // Always set up notifier for this instance, regardless of command registration
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (this._view) {
          // Notify the webview that the active editor has changed
          // TODO: This command is sent but not handled in the webview (no handler in messageHandlers.js)
          // This appears to be an incomplete implementation from commit bb28ecbf
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && activeEditor.document) {
            this._view.webview.postMessage({
              command: MAIN_VIEW_COMMANDS.ACTIVE_EDITOR_CHANGED,
              file: activeEditor.document.fileName,
            });
          }
        }
      }),
    );
  }

  private setupConfigurationWatcher() {
    // Watch for configuration changes
    watchConfig(
      this.context,
      ['texra.agents', 'texra.models', 'texra.files'],
      () => this.refreshOptionsAndView(),
    );
  }

  private async refreshOptionsAndView() {
    if (this._view) {
      this._view.webview.html = this.contentProvider.getHtmlContent(
        this._view.webview,
      );
    }
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
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'common',
          'styles',
        ),
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'common',
          'modules',
        ),
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'common',
          'webview',
        ),
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'node_modules',
          '@vscode',
          'codicons',
          'dist',
        ),
      ],
    };

    super.resolveWebviewViewInternal(webviewView);

    this.setupInitialState(webviewView);

    // Check for missing core dependencies and display banner if needed
    const showDependencyReminders = getConfig<boolean>(
      'ui.showDependencyReminders',
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

    // Check if there's state to restore from the command
    const hasStateToRestore = await vscode.commands.executeCommand(
      'getContext',
      'texra.hasStateToRestore',
    );

    if (hasStateToRestore) {
      try {
        // Get the stored state
        const storedState = await vscode.commands.executeCommand(
          'getContext',
          'texra.stateToRestore',
        );

        let state: unknown = storedState;
        if (typeof storedState === 'string') {
          try {
            state = JSON.parse(storedState);
          } catch (parseError) {
            console.warn(
              'Failed to parse legacy state stored as JSON string:',
              parseError,
            );
            state = undefined;
          }
        }

        if (state && typeof state === 'object') {
          // Send the state to the webview
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
            state,
          });

          console.log('Restored state from context');
        }

        // Clear the stored state regardless of success to avoid loops
        await vscode.commands.executeCommand(
          'setContext',
          'texra.hasStateToRestore',
          false,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'texra.stateToRestore',
          undefined,
        );
      } catch (error) {
        console.error('Error restoring state from context:', error);
      }
    }
  }
}
