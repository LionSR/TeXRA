// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { agentDirectories } from '@frontend/agents';
import { validateYamlAndPromptAdd } from '@frontend/agents';
import * as logger from '@logger/logUtils';
import { debounce } from '@utils/core';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class WatcherManager {
  private disposables: vscode.FileSystemWatcher[] = [];
  private validationHandles: NodeJS.Timeout[] = [];
  private static readonly VALIDATION_DELAY = 300;
  private disposed = false;

  // Debounced refresh using perfect-debounce
  // Wrapped with disposed check since perfect-debounce doesn't expose cancel
  private triggerRefresh: () => void;

  constructor(
    private context: vscode.ExtensionContext | undefined,
    private refresh: () => void,
  ) {
    // Wrap callback with disposed check to prevent execution after dispose
    this.triggerRefresh = debounce(() => {
      if (!this.disposed) {
        this.refresh();
      }
    }, 200);
  }

  async setup() {
    try {
      if (!this.context) {
        logger.warn(
          CHANNEL,
          'Cannot set up file system watcher: context is undefined',
        );
        return;
      }

      this.dispose();
      // Reset disposed flag for re-setup
      this.disposed = false;

      const builtInAgentsPath = await agentDirectories.builtIn();
      const builtInToolUsePath = await agentDirectories.builtInToolUse();
      const customAgentsPath = await agentDirectories.custom();

      const pathsToWatch = [builtInAgentsPath, builtInToolUsePath];
      if (customAgentsPath) {
        pathsToWatch.push(customAgentsPath);
      }

      for (const watchPath of pathsToWatch) {
        if (!watchPath) continue;

        const pattern = new vscode.RelativePattern(watchPath, '**/*');
        const watcher = vscode.workspace.createFileSystemWatcher(
          pattern,
          false,
          false,
          false,
        );
        this.disposables.push(watcher);

        watcher.onDidCreate((uri) => {
          this.triggerRefresh();
          if (path.extname(uri.fsPath).toLowerCase() === '.yaml') {
            const handle = setTimeout(async () => {
              try {
                await validateYamlAndPromptAdd(uri.fsPath);
              } catch (error) {
                logger.error(CHANNEL, `Error validating YAML: ${error}`);
              } finally {
                this.validationHandles = this.validationHandles.filter(
                  (h) => h !== handle,
                );
              }
            }, WatcherManager.VALIDATION_DELAY);

            this.validationHandles.push(handle);
          }
        });
        watcher.onDidDelete(() => this.triggerRefresh());

        if (path.resolve(watchPath) === path.resolve(customAgentsPath ?? '')) {
          watcher.onDidChange(async (uri) => {
            this.triggerRefresh();
            if (path.extname(uri.fsPath).toLowerCase() === '.yaml') {
              await validateYamlAndPromptAdd(uri.fsPath);
            }
          });
        } else {
          watcher.onDidChange(() => this.triggerRefresh());
        }
      }

      logger.info(
        CHANNEL,
        `File system watchers set up for: ${pathsToWatch.filter(Boolean).join(', ')}`,
      );
    } catch (error) {
      logger.error(CHANNEL, `Error setting up file system watcher: ${error}`);
    }
  }

  dispose() {
    // Set disposed flag to prevent debounced refresh from executing
    this.disposed = true;
    this.validationHandles.forEach((h) => clearTimeout(h));
    this.validationHandles = [];
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
