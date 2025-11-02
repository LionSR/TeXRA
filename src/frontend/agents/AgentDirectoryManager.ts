// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig, updateConfig, watchConfig } from '@utils/config';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);
const DEFAULT_CUSTOM_AGENTS_DIR_NAME = 'custom_agents';

const CustomAgentDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .refine(path.isAbsolute, {
    message: 'Custom agents directory must be an absolute path.',
  });

export class AgentDirectoryManager {
  private context: vscode.ExtensionContext | undefined;
  private cachedCustomDir: string | undefined;
  private hasLoadedCustomDir = false;

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
    watchConfig(context, 'texra.explorer.agentsDirectory', () => {
      void this.refreshCustomDirectory();
    });
    void this.refreshCustomDirectory();
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

    await GlobalStorageFS.ensureDir(DEFAULT_CUSTOM_AGENTS_DIR_NAME);

    const defaultPath = GlobalStorageFS.fullPath(
      DEFAULT_CUSTOM_AGENTS_DIR_NAME,
    );
    logger.debug(
      CHANNEL,
      `Using default custom agents directory: ${defaultPath}`,
    );
    return defaultPath;
  }

  private async refreshCustomDirectory(): Promise<void> {
    if (!this.context) {
      return;
    }

    const configured = getConfig<string | undefined>(
      'texra.explorer.agentsDirectory',
    );
    const parsed = CustomAgentDirectorySchema.safeParse(configured ?? '');

    if (!parsed.success) {
      if (configured && configured.trim().length > 0) {
        logger.warn(
          CHANNEL,
          `Ignoring invalid custom agents directory: ${configured}`,
        );
      }
      this.cachedCustomDir = undefined;
      this.hasLoadedCustomDir = true;
      return;
    }

    const resolvedPath = parsed.data;
    const parentDir = path.dirname(resolvedPath);
    const parentExists = await AbsoluteFS.exists(parentDir);

    if (!parentExists) {
      logger.warn(
        CHANNEL,
        `Ignoring custom agents directory because parent is missing: ${parentDir}`,
      );
      this.cachedCustomDir = undefined;
      this.hasLoadedCustomDir = true;
      return;
    }

    await AbsoluteFS.ensureDir(resolvedPath);
    this.cachedCustomDir = resolvedPath;
    this.hasLoadedCustomDir = true;
    logger.debug(
      CHANNEL,
      `Using custom agents directory from setting: ${resolvedPath}`,
    );
  }

  async custom(): Promise<string> {
    this.ensureInitialized();

    if (!this.hasLoadedCustomDir) {
      await this.refreshCustomDirectory();
    }

    if (this.cachedCustomDir) {
      return this.cachedCustomDir;
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
