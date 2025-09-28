// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig, updateConfig } from '@utils/config';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';
import { showLoggedMessageWithDocs } from '@common/errors/errorHandlingUtils';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);
const DEFAULT_CUSTOM_DIR = 'custom_agents';

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

  private async ensureDefaultCustomDir(): Promise<string> {
    await GlobalStorageFS.ensureDir(DEFAULT_CUSTOM_DIR);
    const defaultPath = GlobalStorageFS.fullPath(DEFAULT_CUSTOM_DIR);
    logger.debug(
      CHANNEL,
      `Using default custom agents directory: ${defaultPath}`,
    );
    return defaultPath;
  }

  async custom(): Promise<string> {
    const configuredPath = getConfig<string>('explorer.agentsDirectory', '').trim();

    if (!configuredPath) {
      return this.ensureDefaultCustomDir();
    }

    if (!path.isAbsolute(configuredPath)) {
      logger.error(
        CHANNEL,
        `Custom agents directory must be an absolute path: ${configuredPath}`,
      );
      await showLoggedMessageWithDocs(
        CHANNEL,
        'Custom agents directory must be an absolute path',
        'custom-agents',
      );
      return this.ensureDefaultCustomDir();
    }

    await AbsoluteFS.ensureDir(configuredPath);
    logger.debug(
      CHANNEL,
      `Using custom agents directory from setting: ${configuredPath}`,
    );
    return configuredPath;
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

    await updateConfig('explorer.agentsDirectory', selectedPath);

    return selectedPath;
  }

  async ensureCustom(): Promise<string> {
    return this.custom();
  }
}

export const agentDirectories = new AgentDirectoryManager();
