// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { WebviewMessageHandler } from './webview/MessageHandler';
import { WebviewContentProvider } from './webview/WebviewContentProvider';

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  private messageHandler: WebviewMessageHandler;
  private contentProvider: WebviewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private webviewView: vscode.WebviewView | undefined;

  // Static flag to track if commands have been registered
  private static commandsRegistered = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.messageHandler = new WebviewMessageHandler(context);
    this.contentProvider = new WebviewContentProvider(context);
    this.setupFileWatcher();
    this.setupConfigurationWatcher();
    this.registerCommandHandlers();
  }

  private registerCommandHandlers() {
    // Only register commands if they haven't been registered yet
    if (!CoAuthorViewProvider.commandsRegistered) {
      // Create a promise to check if the command exists and register if it doesn't
      const registerCommandPromise = vscode.commands
        .getCommands(true)
        .then((commands) => {
          if (!commands.includes('coauthor.getWebviewView')) {
            this.context.subscriptions.push(
              vscode.commands.registerCommand('coauthor.getWebviewView', () => {
                return this.webviewView;
              }),
            );
            CoAuthorViewProvider.commandsRegistered = true;
            return true;
          }
          CoAuthorViewProvider.commandsRegistered = true;
          return false;
        });

      // Log the result for diagnostics
      registerCommandPromise.then((registered) => {
        if (registered) {
          console.log('Registered coauthor.getWebviewView command');
        } else {
          console.log(
            'Command coauthor.getWebviewView already exists, skipped registration',
          );
        }
      });
    }

    // Always set up notifier for this instance, regardless of command registration
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (this.webviewView) {
          // Notify the webview that the active editor has changed
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && activeEditor.document) {
            this.webviewView.webview.postMessage({
              command: 'activeEditorChanged',
              file: activeEditor.document.fileName,
            });
          }
        }
      }),
    );
  }

  private setupConfigurationWatcher() {
    // Watch for configuration changes
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('coauthor.agents') ||
          e.affectsConfiguration('coauthor.models') ||
          e.affectsConfiguration('coauthor.files')
        ) {
          this.refreshOptionsAndView();
        }
      }),
    );
  }

  private refreshOptionsAndView() {
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
        { command: 'refreshAllFiles' },
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
  }

  private async setupInitialState(webviewView: vscode.WebviewView) {
    webviewView.webview.postMessage({ command: 'requestBaseFile' });

    // Check if there's state to restore from the command
    const hasStateToRestore = await vscode.commands.executeCommand(
      'getContext',
      'coauthor.hasStateToRestore',
    );

    if (hasStateToRestore) {
      try {
        // Get the stored state
        const stateJson = await vscode.commands.executeCommand(
          'getContext',
          'coauthor.stateToRestore',
        );
        if (stateJson) {
          const state = JSON.parse(stateJson as string);

          // Send the state to the webview
          webviewView.webview.postMessage({
            command: 'restoreState',
            state,
          });

          // Clear the stored state
          await vscode.commands.executeCommand(
            'setContext',
            'coauthor.hasStateToRestore',
            false,
          );
          await vscode.commands.executeCommand(
            'setContext',
            'coauthor.stateToRestore',
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
