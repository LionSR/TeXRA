// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';
import { safeExecuteCommand } from '@utils/system';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);

export class AgentDirectoryManager {
  /**
   * Ensure a built-in agents directory exists and return its path.
   */
  private async ensureBuiltInDir(
    context: vscode.ExtensionContext,
    dirName: string,
  ): Promise<string> {
    if (!context) {
      throw new Error('Extension context required for built-in agents');
    }

    StorageFS.initialize(context);
    await GlobalStorageFS.ensureDir(dirName);

    const basePath = GlobalStorageFS.fullPath(dirName);
    const label = dirName === 'tool_use_agents' ? 'tool-use' : dirName;
    logger.debug(CHANNEL, `Using built-in ${label} directory: ${basePath}`);

    return basePath;
  }

  async builtIn(context: vscode.ExtensionContext): Promise<string> {
    return this.ensureBuiltInDir(context, 'agents');
  }

  async builtInToolUse(context: vscode.ExtensionContext): Promise<string> {
    return this.ensureBuiltInDir(context, 'tool_use_agents');
  }

  async custom(): Promise<string> {
    const customPath = getConfig<string>('explorer.agentsDirectory', '');

    if (!customPath) {
      return '';
    }

    if (!path.isAbsolute(customPath)) {
      logger.error(
        CHANNEL,
        `Custom agents directory must be an absolute path: ${customPath}`,
      );
      const docsAction = 'View Docs';
      const selection = await vscode.window.showErrorMessage(
        'Custom agents directory must be an absolute path',
        docsAction,
      );
      if (selection === docsAction) {
        await safeExecuteCommand('texra.openDoc', ['custom-agents'], CHANNEL);
      }
      return '';
    }

    return customPath;
  }

  async promptCustom(): Promise<string | undefined> {
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Folder',
    });

    if (!folder || folder.length === 0) {
      return undefined;
    }

    const selectedPath = folder[0].fsPath;
    await AbsoluteFS.ensureDir(selectedPath);

    const config = vscode.workspace.getConfiguration();
    await config.update(
      'texra.explorer.agentsDirectory',
      selectedPath,
      vscode.ConfigurationTarget.Workspace,
    );

    return selectedPath;
  }

  async ensureCustom(): Promise<string | undefined> {
    const current = await this.custom();
    if (current) {
      return current;
    }
    return this.promptCustom();
  }
}

export const agentDirectories = new AgentDirectoryManager();
