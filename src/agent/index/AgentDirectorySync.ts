import * as path from 'node:path';

import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { GlobalStorageFS } from '@utils/files/storageFS';

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
const SYNC_MARKER_FILE = '.bundled-agent-sync.json';
const RECENT_EXTERNAL_SYNC_MS = 5 * 60 * 1000;

const AgentDirectorySyncMarkerSchema = z.object({
  completedAt: z.number().nonnegative(),
  ownerPid: z.int().nonnegative(),
  version: z.string().nullish(),
});

type AgentDirectorySyncMarker = z.output<typeof AgentDirectorySyncMarkerSchema>;

export interface AgentDirectoryBundleSource {
  copyDirectory(
    directoryName: BundledAgentDirectoryName,
    destinationPath: string,
  ): Promise<void>;
}

export interface AgentDirectoryStorage {
  ensureDir(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
  delete(relativePath: string): Promise<void>;
  fullPath(relativePath: string): string;
}

export interface AgentDirectoryVersionStore {
  get(): string | undefined;
  update(version: string | undefined): PromiseLike<void>;
}

interface AgentDirectorySyncLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
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
    await platform().fs.copy(
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

  read(relativePath: string): Promise<string> {
    return GlobalStorageFS.read(relativePath);
  }

  write(relativePath: string, content: string): Promise<void> {
    return GlobalStorageFS.write(relativePath, content);
  }

  delete(relativePath: string): Promise<void> {
    return GlobalStorageFS.delete(relativePath);
  }

  fullPath(relativePath: string): string {
    return GlobalStorageFS.fullPath(relativePath);
  }
}

export class BundledAgentDirectorySync {
  private static readonly reconcileByStorageRoot = new Map<
    string,
    Promise<boolean>
  >();

  constructor(private readonly options: BundledAgentDirectorySyncOptions) {}

  async reconcile(currentVersion: string | undefined): Promise<boolean> {
    const storageRoot = this.options.storage.fullPath('');
    const previous =
      BundledAgentDirectorySync.reconcileByStorageRoot.get(storageRoot) ??
      Promise.resolve(true);
    const current = previous
      .catch(() => true)
      .then(() => this.reconcileUnlocked(currentVersion));
    const tracked = current.finally(() => {
      if (
        BundledAgentDirectorySync.reconcileByStorageRoot.get(storageRoot) ===
        tracked
      ) {
        BundledAgentDirectorySync.reconcileByStorageRoot.delete(storageRoot);
      }
    });
    tracked.catch(() => undefined);
    BundledAgentDirectorySync.reconcileByStorageRoot.set(storageRoot, tracked);
    return current;
  }

  private async reconcileUnlocked(
    currentVersion: string | undefined,
  ): Promise<boolean> {
    await this.deleteLegacyAgentFiles();
    if (await this.hasRecentExternalSync(currentVersion)) {
      await this.options.versionStore.update(currentVersion);
      return false;
    }

    for (const directoryName of BUNDLED_AGENT_DIRECTORY_NAMES) {
      await this.options.storage.ensureDir(directoryName);
      await this.options.bundleSource.copyDirectory(
        directoryName,
        this.options.storage.fullPath(directoryName),
      );
    }

    await this.options.versionStore.update(currentVersion);
    await this.writeSyncMarker(currentVersion);
    return true;
  }

  private async hasRecentExternalSync(
    currentVersion: string | undefined,
  ): Promise<boolean> {
    const marker = await this.readSyncMarker();
    if (!marker || marker.ownerPid === process.pid) return false;
    if ((marker.version ?? undefined) !== currentVersion) return false;
    return Date.now() - marker.completedAt < RECENT_EXTERNAL_SYNC_MS;
  }

  private async readSyncMarker(): Promise<
    AgentDirectorySyncMarker | undefined
  > {
    try {
      const raw = await this.options.storage.read(SYNC_MARKER_FILE);
      return AgentDirectorySyncMarkerSchema.optional()
        .catch(undefined)
        .parse(JSON.parse(raw));
    } catch (error) {
      if (isFileNotFoundError(error)) return undefined;
      this.options.logger.warn(
        `Ignoring bundled agent sync marker: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async writeSyncMarker(
    currentVersion: string | undefined,
  ): Promise<void> {
    try {
      await this.options.storage.ensureDir('');
      await this.options.storage.write(
        SYNC_MARKER_FILE,
        `${JSON.stringify({
          completedAt: Date.now(),
          ownerPid: process.pid,
          version: currentVersion,
        })}\n`,
      );
    } catch (error) {
      this.options.logger.warn(
        `Failed to write bundled agent sync marker: ${toErrorMessage(error)}`,
      );
    }
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
          `Failed to delete legacy agent file ${legacyFile}`,
          error,
        );
      }
    }
  }
}
