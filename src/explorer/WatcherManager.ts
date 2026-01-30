// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { agentDirectories, validateYamlAndPromptAdd } from '@frontend/agents';
import * as logger from '@logger/logUtils';
import { debounce } from '@utils/core';
import { DEBOUNCE_WATCHER_MS } from '@utils/config';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class WatcherManager {
  private validationHandles: NodeJS.Timeout[] = [];
  private static readonly VALIDATION_DELAY = 300;
  private disposed = false;
  private agentWatcher: vscode.Disposable | undefined;

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

      this.agentWatcher = agentDirectories.watchAgentDirectories({
        pattern: '**/*',
        debounceMs: DEBOUNCE_WATCHER_MS,
        onEvent: (event) => {
          this.triggerRefresh();
          if (event.source === 'custom' && event.type !== 'delete') {
            scheduleYamlValidation(event.uri);
          }
        },
      });

      logger.info(CHANNEL, 'Shared agent directory watcher enabled.');
    } catch (error) {
      logger.error(CHANNEL, `Error setting up file system watcher: ${error}`);
    }
  }

  dispose() {
    // Set disposed flag to prevent debounced refresh from executing
    this.disposed = true;
    this.validationHandles.forEach((h) => clearTimeout(h));
    this.validationHandles = [];
    this.agentWatcher?.dispose();
    this.agentWatcher = undefined;
  }
}
