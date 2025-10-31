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

// Local imports - agent utilities
import type { AgentDirectoryMap } from '@agent/utils/agentOptionMetadata';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);
const DEFAULT_CUSTOM_AGENTS_DIR_NAME = 'custom_agents';

export class AgentDirectoryManager {
  private context: vscode.ExtensionContext | undefined;

  /**
   * Ensure a built-in agents directory exists and return its path.
   */
  private async ensureBuiltInDir(dirName: string): Promise<string> {
    this.ensureInitialized();

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

  private ensureInitialized(): vscode.ExtensionContext {
    if (!this.context) {
      throw new Error(
        'Agent directories not initialized. Call agentDirectories.initialize(context) first.',
      );
    }

    StorageFS.initialize(this.context);
    return this.context;
  }

  async builtIn(): Promise<string> {
    return this.ensureBuiltInDir('agents');
  }

  async builtInToolUse(): Promise<string> {
    return this.ensureBuiltInDir('tool_use_agents');
  }

  private async ensureDefaultCustomDir(): Promise<string> {
    this.ensureInitialized();

    try {
      await GlobalStorageFS.ensureDir(DEFAULT_CUSTOM_AGENTS_DIR_NAME);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        CHANNEL,
        `Failed to create default custom agents directory: ${message}`,
      );
      throw new Error(
        'Unable to create custom agents directory. Please check permissions.',
      );
    }

    const defaultPath = GlobalStorageFS.fullPath(
      DEFAULT_CUSTOM_AGENTS_DIR_NAME,
    );
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

    const parentDir = path.dirname(configuredPath);
    const parentExists = await AbsoluteFS.exists(parentDir);
    if (!parentExists) {
      logger.error(
        CHANNEL,
        `Parent directory does not exist for custom agents directory: ${parentDir}`,
      );
      await showLoggedMessageWithDocs(
        CHANNEL,
        'Parent directory for custom agents directory does not exist',
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

  async custom(): Promise<string> {
    this.ensureInitialized();
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

  async getDirectoryMap(): Promise<AgentDirectoryMap> {
    this.ensureInitialized();

    const [builtIn, builtInToolUse, custom] = await Promise.all([
      this.builtIn(),
      this.builtInToolUse(),
      this.custom(),
    ]);

    return { builtIn, builtInToolUse, custom };
  }
}

export const agentDirectories = new AgentDirectoryManager();
