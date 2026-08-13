import * as path from 'node:path';

import pRetry from 'p-retry';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { GlobalStorageFS } from '@utils/files/storageFS';

import {
  BUNDLED_AGENT_DIRECTORY_NAMES,
  type BundledAgentDirectoryName,
} from './BundledAgentDirectories';

const SYNC_MARKER_FILE = '.bundled-agent-sync.json';
const RECENT_EXTERNAL_SYNC_MS = 5 * 60 * 1000;
const LOCK_RETRY_TIMEOUT_MS = 30_000;

function isLockContentionError(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ELOCKED';
}

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
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
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

  read(relativePath: string): Promise<string> {
    return GlobalStorageFS.read(relativePath);
  }

  write(relativePath: string, content: string): Promise<void> {
    return GlobalStorageFS.write(relativePath, content);
  }

  fullPath(relativePath: string): string {
    return GlobalStorageFS.fullPath(relativePath);
  }
}

export class BundledAgentDirectorySync {
  constructor(private readonly options: BundledAgentDirectorySyncOptions) {}

  async reconcile(currentVersion: string | undefined): Promise<boolean> {
    let operationStarted = false;

    try {
      return await pRetry(
        () =>
          platform().fileLocks.runExclusive(
            this.options.storage.fullPath(SYNC_MARKER_FILE),
            () => {
              operationStarted = true;
              return this.reconcileUnlocked(currentVersion);
            },
          ),
        {
          retries: 20,
          minTimeout: 100,
          maxTimeout: 1_000,
          randomize: true,
          maxRetryTime: LOCK_RETRY_TIMEOUT_MS,
          shouldRetry: ({ error }) =>
            !operationStarted && isLockContentionError(error),
        },
      );
    } catch (error) {
      // A live or stale owner must not make startup fail. If ownership remains
      // unavailable, leave the shared cache untouched and try again next run.
      if (!operationStarted && isLockContentionError(error)) {
        this.options.logger.warn(
          'Skipping bundled agent refresh because another process still owns the sync lock',
        );
        return false;
      }
      throw error;
    }
  }

  private async reconcileUnlocked(
    currentVersion: string | undefined,
  ): Promise<boolean> {
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
      const parsed = AgentDirectorySyncMarkerSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.options.logger.warn(
          `Ignoring malformed bundled agent sync marker: ${z.prettifyError(parsed.error)}`,
        );
        return undefined;
      }
      return parsed.data;
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
}
