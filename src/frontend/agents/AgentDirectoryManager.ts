// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';
import { showLoggedMessageWithDocs } from '@common/errors/errorHandlingUtils';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);

export class AgentDirectoryManager {
  async builtIn(context: vscode.ExtensionContext): Promise<string> {
    if (!context) {
      throw new Error('Extension context required for built-in agents');
    }

    StorageFS.initialize(context);
    await GlobalStorageFS.ensureDir('agents');

    const basePath = GlobalStorageFS.fullPath('agents');
    logger.debug(CHANNEL, `Using built-in agents directory: ${basePath}`);

    return basePath;
  }

  async builtInToolUse(context: vscode.ExtensionContext): Promise<string> {
    if (!context) {
      throw new Error('Extension context required for built-in agents');
    }

    StorageFS.initialize(context);
    await GlobalStorageFS.ensureDir('tool_use_agents');

    const basePath = GlobalStorageFS.fullPath('tool_use_agents');
    logger.debug(CHANNEL, `Using built-in tool-use directory: ${basePath}`);

    return basePath;
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
      await showLoggedMessageWithDocs(
        CHANNEL,
        'Custom agents directory must be an absolute path',
        'custom-agents',
      );
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
