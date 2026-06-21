// Standard library imports
import * as path from 'node:path';

// Third-party imports
import fsExtra from 'fs-extra';

// Local imports
import { toErrorMessage } from '@common/errors';
import { GlobalStorageFS } from '@utils/files/storageFS';

// Local imports - agent index
import {
  BUNDLED_AGENT_DIRECTORY_NAMES,
  type BundledAgentDirectoryName,
} from './BundledAgentDirectories';

const LEGACY_AGENT_FILES = [
  'agents/generic.yaml',
  'agents/generic_multiple.yaml',
  'agents/correct_multiple.yaml',
  'agents/polish_multiple.yaml',
  'agents/merge_multiple.yaml',
  'agents/write/paper2cover.yaml',
  'agents/write/write_slide.yaml',
];

export interface AgentDirectoryBundleSource {
  copyDirectory(
    directoryName: BundledAgentDirectoryName,
    destinationPath: string,
  ): Promise<void>;
}

export interface AgentDirectoryStorage {
  ensureDir(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  delete(relativePath: string): Promise<void>;
  fullPath(relativePath: string): string;
}

export interface AgentDirectoryVersionStore {
  get(): string | undefined;
  update(version: string | undefined): PromiseLike<void>;
}

export interface AgentDirectorySyncLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface BundledAgentDirectorySyncOptions {
  bundleSource: AgentDirectoryBundleSource;
  storage: AgentDirectoryStorage;
  versionStore: AgentDirectoryVersionStore;
  logger: AgentDirectorySyncLogger;
}

export class PathAgentDirectoryBundleSource implements AgentDirectoryBundleSource {
  constructor(private readonly resourcesBasePath: string) {}

  async copyDirectory(
    directoryName: BundledAgentDirectoryName,
    destinationPath: string,
  ): Promise<void> {
    await fsExtra.copy(
      path.join(this.resourcesBasePath, directoryName),
      destinationPath,
      { overwrite: true },
    );
  }
}

export class GlobalStorageAgentDirectoryStorage implements AgentDirectoryStorage {
  ensureDir(relativePath: string): Promise<void> {
    return GlobalStorageFS.ensureDir(relativePath);
  }

  exists(relativePath: string): Promise<boolean> {
    return GlobalStorageFS.exists(relativePath);
  }

  delete(relativePath: string): Promise<void> {
    return GlobalStorageFS.delete(relativePath);
  }

  fullPath(relativePath: string): string {
    return GlobalStorageFS.fullPath(relativePath);
  }
}

export class BundledAgentDirectorySync {
  constructor(private readonly options: BundledAgentDirectorySyncOptions) {}

  async reconcile(currentVersion: string | undefined): Promise<boolean> {
    await this.deleteLegacyAgentFiles();

    for (const directoryName of BUNDLED_AGENT_DIRECTORY_NAMES) {
      await this.options.storage.ensureDir(directoryName);
      await this.options.bundleSource.copyDirectory(
        directoryName,
        this.options.storage.fullPath(directoryName),
      );
    }

    await this.options.versionStore.update(currentVersion);
    return true;
  }

  private async deleteLegacyAgentFiles(): Promise<void> {
    for (const legacyFile of LEGACY_AGENT_FILES) {
      if (!(await this.options.storage.exists(legacyFile))) {
        continue;
      }
      try {
        await this.options.storage.delete(legacyFile);
        this.options.logger.info(`Deleted legacy agent file: ${legacyFile}`);
      } catch (error) {
        this.options.logger.warn(
          `Failed to delete legacy agent file ${legacyFile}: ${toErrorMessage(error)}`,
        );
      }
    }
  }
}
