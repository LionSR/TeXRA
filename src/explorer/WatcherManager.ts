// Standard library imports
import * as path from 'path';
// Third-party imports
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

// Local imports
import {
  getBuiltInAgentsDirectory,
  getCustomAgentsDirectory,
} from '@frontend/agents/pathUtils';
import { isValidAgentYaml } from '../agent/runtime/agentLoad';
import { promptToAddAgentToConfig } from '@frontend/agents/register';
import { getConfig } from '@utils/config';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class WatcherManager {
  private disposables: vscode.FileSystemWatcher[] = [];
  private refreshHandle: NodeJS.Timeout | undefined;

  constructor(
    private context: vscode.ExtensionContext | undefined,
    private refresh: () => void,
  ) {}

  private triggerRefresh() {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
    }
    this.refreshHandle = setTimeout(() => this.refresh(), 200);
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

      const builtInAgentsPath = await getBuiltInAgentsDirectory(this.context);
      const customAgentsPath = await getCustomAgentsDirectory();

      const pathsToWatch = [builtInAgentsPath];
      if (customAgentsPath) {
        pathsToWatch.push(customAgentsPath);
      }

      for (const watchPath of pathsToWatch) {
        if (!watchPath) continue;

        const pattern = new vscode.RelativePattern(watchPath, '**/*.yaml');
        const watcher = vscode.workspace.createFileSystemWatcher(
          pattern,
          false,
          false,
          false,
        );
        this.disposables.push(watcher);

        watcher.onDidCreate(() => this.triggerRefresh());
        watcher.onDidDelete(() => this.triggerRefresh());

        if (path.resolve(watchPath) === path.resolve(customAgentsPath ?? '')) {
          watcher.onDidChange(async (uri) => {
            this.triggerRefresh();

            const filePath = uri.fsPath;
            if (!filePath.endsWith('.yaml')) {
              return;
            }

            const validationResult = await isValidAgentYaml(filePath);
            if (validationResult) {
              const filenameBase = path.basename(filePath, '.yaml');
              const internalName = validationResult.name;
              if (filenameBase !== internalName) {
                vscode.window.showWarningMessage(
                  `Agent file '${filenameBase}.yaml' has a different internal name '${internalName}' defined in its YAML. ` +
                    `Consider renaming the file or updating the internal name in the YAML for consistency.`,
                );
              } else {
                const configuredAgents = getConfig<string[]>(
                  'texra.agents',
                  [],
                );
                if (!configuredAgents.includes(filenameBase)) {
                  await promptToAddAgentToConfig(filenameBase);
                }
              }
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
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
