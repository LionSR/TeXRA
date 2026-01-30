// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - frontend agents
import { agentDirectories, validateYamlAndPromptAdd } from '@frontend/agents';
// Local imports - logger
import * as logger from '@logger/logUtils';
// Local imports - utils
import { debounce } from '@utils/core';
import { DEBOUNCE_WATCHER_MS } from '@utils/config';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class WatcherManager {
  private watcherDisposable: vscode.Disposable | undefined;
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
    }, DEBOUNCE_WATCHER_MS);
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

      // Clean up any existing watchers before setting up new ones
      this.dispose();
      // Re-enable after dispose() set it to true - allows new watchers to trigger refresh
      this.disposed = false;

      const customAgentsPath = await agentDirectories.custom();
      const isCustomPath = (watchPath: string): boolean =>
        path
          .resolve(watchPath)
          .startsWith(path.resolve(customAgentsPath ?? ''));

      const scheduleYamlValidation = (uri: vscode.Uri) => {
        if (path.extname(uri.fsPath).toLowerCase() !== '.yaml') {
          return;
        }
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
      };

      this.watcherDisposable = agentDirectories.registerWatcher({
        pattern: '**/*',
        debounceMs: 0,
        onEvent: (event) => {
          const refreshAndValidate = () => {
            this.triggerRefresh();
            scheduleYamlValidation(event.uri);
          };

          if (event.type === 'create') {
            refreshAndValidate();
            return;
          }

          if (event.type === 'change') {
            if (isCustomPath(event.uri.fsPath)) {
              refreshAndValidate();
              return;
            }
            this.triggerRefresh();
          }

          if (event.type === 'delete') {
            this.triggerRefresh();
          }
        },
      });

      logger.info(CHANNEL, 'File system watchers set up for agent directories');
    } catch (error) {
      logger.error(CHANNEL, `Error setting up file system watcher: ${error}`);
    }
  }

  dispose() {
    // Set disposed flag to prevent debounced refresh from executing
    this.disposed = true;
    this.validationHandles.forEach((h) => clearTimeout(h));
    this.validationHandles = [];
    this.watcherDisposable?.dispose();
    this.watcherDisposable = undefined;
  }
}
