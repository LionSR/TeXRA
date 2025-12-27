// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { AgentSource } from '@agent/core/AgentDataclass';

// Local imports - log
import { showLoggedMessageWithDocs, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getConfig, updateConfig } from '@utils/config';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';

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

  /**
   * Get the directory for a given source type.
   * Returns undefined for Remote sources (which have no local directory).
   */
  async getDirectory(source: AgentSource): Promise<string | undefined> {
    switch (source) {
      case 'custom':
        return this.custom();
      case 'builtIn':
        return this.builtIn();
      case 'builtInToolUse':
        return this.builtInToolUse();
      case 'remote':
        return undefined;
    }
  }

  /**
   * Get all local agent directories (excludes Remote).
   * Returns directories in priority order: Custom, BuiltIn, BuiltInToolUse.
   */
  async getAllLocal(): Promise<
    Array<{ directory: string; source: AgentSource }>
  > {
    const [customDir, builtInDir, builtInToolUseDir] = await Promise.all([
      this.custom(),
      this.builtIn(),
      this.builtInToolUse(),
    ]);

    return [
      { directory: customDir, source: 'custom' as const },
      { directory: builtInDir, source: 'builtIn' as const },
      { directory: builtInToolUseDir, source: 'builtInToolUse' as const },
    ];
  }

  private async ensureDefaultCustomDir(): Promise<string> {
    this.ensureInitialized();

    try {
      await GlobalStorageFS.ensureDir(DEFAULT_CUSTOM_AGENTS_DIR_NAME);
    } catch (error) {
      const message = toErrorMessage(error);
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
      'texra.explorer.agentsDirectory',
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

    await updateConfig('texra.explorer.agentsDirectory', selectedPath, {
      prefix: false,
    });

    return selectedPath;
  }
}

export const agentDirectories = new AgentDirectoryManager();
