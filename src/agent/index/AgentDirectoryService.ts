// Standard library imports
import * as path from 'node:path';

// Local imports
import { CUSTOM_AGENTS_STORAGE_DIR } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { GlobalStorageFS } from '@utils/files/storageFS';

import {
  BUILTIN_WORKFLOW_AGENTS_DIR,
  BUILTIN_TOOL_USE_AGENTS_DIR,
} from './BundledAgentDirectories';

interface CustomAgentDirectoryStore {
  get(): string | undefined;
}

type AgentDirectoryDocsId = 'custom-agents';

/** A local agent directory paired with the source it represents. */
export interface AgentDirectoryEntry {
  directory: string;
  source: AgentSource;
}

export interface AgentDirectoryIssueReporter {
  report(message: string, docsId: AgentDirectoryDocsId): Promise<void>;
}

export interface AgentDirectoryServiceOptions {
  channel: string;
  customDirectoryStore: CustomAgentDirectoryStore;
  issueReporter: AgentDirectoryIssueReporter;
}

export class AgentDirectoryService {
  private readonly log: ReturnType<typeof createLog>;

  constructor(private readonly options: AgentDirectoryServiceOptions) {
    this.log = createLog(options.channel);
  }

  async builtIn(): Promise<string> {
    return this.ensureBuiltInDir(BUILTIN_WORKFLOW_AGENTS_DIR);
  }

  async builtInToolUse(): Promise<string> {
    return this.ensureBuiltInDir(BUILTIN_TOOL_USE_AGENTS_DIR);
  }

  async custom(): Promise<string> {
    const configuredPath = (
      this.options.customDirectoryStore.get() ?? ''
    ).trim();

    const resolvedPath = await this.resolveConfiguredCustomDir(configuredPath);
    return resolvedPath ?? this.ensureDefaultCustomDir();
  }

  async getDirectory(source: AgentSource): Promise<string | undefined> {
    switch (source) {
      case 'custom':
        return this.custom();
      case 'builtInWorkflow':
        return this.builtIn();
      case 'builtInToolUse':
        return this.builtInToolUse();
      // Neither has a local directory: a remote agent lives in Supabase, an
      // inline one was supplied as a value and was never written to disk.
      case 'remote':
      case 'inline':
        return undefined;
    }
  }

  async getAllLocal(): Promise<AgentDirectoryEntry[]> {
    const [customDir, builtInDir, builtInToolUseDir] = await Promise.all([
      this.custom(),
      this.builtIn(),
      this.builtInToolUse(),
    ]);

    return [
      { directory: customDir, source: 'custom' },
      { directory: builtInDir, source: 'builtInWorkflow' },
      { directory: builtInToolUseDir, source: 'builtInToolUse' },
    ];
  }

  private async ensureBuiltInDir(dirName: string): Promise<string> {
    await GlobalStorageFS.ensureDir(dirName);
    const basePath = GlobalStorageFS.fullPath(dirName);
    this.log.debug(`Using built-in ${dirName} directory: ${basePath}`);
    return basePath;
  }

  private async ensureDefaultCustomDir(): Promise<string> {
    try {
      await GlobalStorageFS.ensureDir(CUSTOM_AGENTS_STORAGE_DIR);
    } catch (error) {
      this.log.error('Failed to create default custom agents directory', {
        data: error,
      });
      throw new Error(
        'Unable to create custom agents directory. Please check permissions.',
      );
    }

    const defaultPath = GlobalStorageFS.fullPath(CUSTOM_AGENTS_STORAGE_DIR);
    this.log.debug(`Using default custom agents directory: ${defaultPath}`);
    return defaultPath;
  }

  private async resolveConfiguredCustomDir(
    configuredPath: string,
  ): Promise<string | undefined> {
    if (!configuredPath) {
      return undefined;
    }

    if (!path.isAbsolute(configuredPath)) {
      this.log.error(
        `Custom agents directory must be an absolute path: ${configuredPath}`,
      );
      await this.options.issueReporter.report(
        'Custom agents directory must be an absolute path',
        'custom-agents',
      );
      return undefined;
    }

    const parentDir = path.dirname(configuredPath);
    if (!(await AbsoluteFS.exists(parentDir))) {
      this.log.error(
        `Parent directory does not exist for custom agents directory: ${parentDir}`,
      );
      await this.options.issueReporter.report(
        'Parent directory for custom agents directory does not exist',
        'custom-agents',
      );
      return undefined;
    }

    await AbsoluteFS.ensureDir(configuredPath);
    this.log.debug(
      `Using custom agents directory from setting: ${configuredPath}`,
    );
    return configuredPath;
  }
}
