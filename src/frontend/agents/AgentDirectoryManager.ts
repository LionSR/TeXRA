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
const DEFAULT_CUSTOM_AGENTS_DIRNAME = 'custom_agents';

export class AgentDirectoryManager {
  private context: vscode.ExtensionContext | undefined;

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

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    StorageFS.initialize(context);
  }

  private ensureInitialized(): void {
    if (!this.context) {
      throw new Error(
        'Agent directories not initialized. Call agentDirectories.initialize(context) first.',
      );
    }

    StorageFS.initialize(this.context);
  }

  async builtIn(context: vscode.ExtensionContext): Promise<string> {
    return this.ensureBuiltInDir(context, 'agents');
  }

  async builtInToolUse(context: vscode.ExtensionContext): Promise<string> {
    return this.ensureBuiltInDir(context, 'tool_use_agents');
  }

  private async ensureDefaultCustomDir(): Promise<string> {
    this.ensureInitialized();
    await GlobalStorageFS.ensureDir(DEFAULT_CUSTOM_AGENTS_DIRNAME);
    const defaultPath = GlobalStorageFS.fullPath(DEFAULT_CUSTOM_AGENTS_DIRNAME);
    logger.debug(
      CHANNEL,
      `Using default custom agents directory: ${defaultPath}`,
    );
    return defaultPath;
  }

  private async resolveConfiguredCustomDir(
    configuredPath: string,
  ): Promise<string | undefined> {
    if (!configuredPath) {
      return undefined;
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
      return undefined;
    }

    await AbsoluteFS.ensureDir(configuredPath);
    logger.debug(
      CHANNEL,
      `Using custom agents directory from setting: ${configuredPath}`,
    );
    return configuredPath;
  }

  async custom(context?: vscode.ExtensionContext): Promise<string> {
    if (context) {
      this.initialize(context);
    }

    const configuredPath = getConfig<string>(
      'explorer.agentsDirectory',
      '',
    ).trim();

    const resolvedPath = await this.resolveConfiguredCustomDir(configuredPath);
    if (resolvedPath) {
      return resolvedPath;
    }

    return this.ensureDefaultCustomDir();
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
}

export const agentDirectories = new AgentDirectoryManager();
