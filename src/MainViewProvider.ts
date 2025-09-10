// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { MainViewMessageHandler } from './webview/MainViewMessageHandler';
import { MainViewContentProvider } from './webview/MainViewContentProvider';
import { SecretManager } from '@frontend/secretManager';
import { watchConfig, getConfig } from '@utils/config';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

export class MainViewProvider implements vscode.WebviewViewProvider {
  private messageHandler: MainViewMessageHandler;
  private contentProvider: MainViewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private webviewView: vscode.WebviewView | undefined;

  // Static flag to track if commands have been registered
  private static commandsRegistered = false;

  constructor(private readonly context: vscode.ExtensionContext) {
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
                return this.webviewView;
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
        if (this.webviewView) {
          // Notify the webview that the active editor has changed
          // TODO: This command is sent but not handled in the webview (no handler in messageHandlers.js)
          // This appears to be an incomplete implementation from commit bb28ecbf
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && activeEditor.document) {
            this.webviewView.webview.postMessage({
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
    if (this.webviewView) {
      this.webviewView.webview.html = this.contentProvider.getHtmlContent(
        this.webviewView.webview,
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
    if (this.webviewView) {
      await this.messageHandler.handleMessage(
        { command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES },
        this.webviewView,
      );
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
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

    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.messageHandler.handleMessage(message, webviewView);
    });

    this.setupInitialState(webviewView);

    // Check if any API keys are set and display banner if needed
    const showReminders = getConfig<boolean>('ui.showApiKeyReminders', true);

    if (showReminders) {
      SecretManager.anyApiKeyExists().then((exists) => {
        if (!exists) {
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
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
        const stateJson = await vscode.commands.executeCommand(
          'getContext',
          'texra.stateToRestore',
        );
        if (stateJson) {
          const state = JSON.parse(stateJson as string);

          // Send the state to the webview
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
            state,
          });

          // Clear the stored state
          await vscode.commands.executeCommand(
            'setContext',
            'texra.hasStateToRestore',
            false,
          );
          await vscode.commands.executeCommand(
            'setContext',
            'texra.stateToRestore',
            '',
          );

          console.log('Restored state from context');
        }
      } catch (error) {
        console.error('Error restoring state from context:', error);
      }
    }
  }
}
