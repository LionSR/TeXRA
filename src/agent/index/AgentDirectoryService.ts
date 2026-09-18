// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports
import { CUSTOM_AGENTS_STORAGE_DIR } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import {
  AgentDirectoriesFailed,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import { GlobalStorageFs } from '@platform/rootedFs';
import type { AgentSource } from '@shared/schemas';
import { entryExists } from '@utils/files/fsEntryExists';

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
  /**
   * Packaged resources root holding the bundled agent directories. Hosts read
   * their built-in agents straight out of the bundle they shipped with, so one
   * host's install can never overwrite another's built-ins.
   */
  resourcesPath: string;
  customDirectoryStore: CustomAgentDirectoryStore;
  issueReporter: AgentDirectoryIssueReporter;
}

export class AgentDirectoryService {
  private readonly log: ReturnType<typeof createLog>;

  constructor(private readonly options: AgentDirectoryServiceOptions) {
    this.log = createLog(options.channel);
  }

  builtIn(): Effect.Effect<string, AgentDirectoriesFailed> {
    return Effect.sync(() => this.packagedDir(BUILTIN_WORKFLOW_AGENTS_DIR));
  }

  builtInToolUse(): Effect.Effect<string, AgentDirectoriesFailed> {
    return Effect.sync(() => this.packagedDir(BUILTIN_TOOL_USE_AGENTS_DIR));
  }

  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      const configuredPath = (
        this.options.customDirectoryStore.get() ?? ''
      ).trim();

      const resolvedPath =
        yield* this.resolveConfiguredCustomDir(configuredPath);
      if (resolvedPath != null) return resolvedPath;
      return yield* this.ensureDefaultCustomDir();
    });
  }

  getAllLocal(): Effect.Effect<
    AgentDirectoryEntry[],
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      const [customDir, builtInDir, builtInToolUseDir] = yield* Effect.all(
        [this.custom(), this.builtIn(), this.builtInToolUse()],
        { concurrency: 'unbounded' },
      );

      const entries: AgentDirectoryEntry[] = [
        { directory: customDir, source: 'custom' },
        { directory: builtInDir, source: 'builtInWorkflow' },
        { directory: builtInToolUseDir, source: 'builtInToolUse' },
      ];
      return entries;
    });
  }

  /**
   * The packaged directory itself. It ships read-only with the host and every
   * consumer registers it `writable: false`, so there is nothing to create.
   */
  private packagedDir(dirName: string): string {
    const basePath = path.join(this.options.resourcesPath, dirName);
    this.log.debug(`Using built-in ${dirName} directory: ${basePath}`);
    return basePath;
  }

  private ensureDefaultCustomDir(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs
  > {
    return Effect.gen({ self: this }, function* () {
      const globalStorageFs = yield* GlobalStorageFs;
      const defaultPath = yield* globalStorageFs
        .makeDirectory(CUSTOM_AGENTS_STORAGE_DIR, { recursive: true })
        .pipe(
          Effect.andThen(() =>
            globalStorageFs.resolve(CUSTOM_AGENTS_STORAGE_DIR),
          ),
          Effect.catch((cause) => {
            this.log.error('Failed to create default custom agents directory', {
              data: cause,
            });
            return Effect.fail(
              new AgentDirectoriesFailed({
                source: 'custom',
                message:
                  'Unable to create custom agents directory. Please check permissions.',
                cause,
              }),
            );
          }),
        );
      this.log.debug(`Using default custom agents directory: ${defaultPath}`);
      return defaultPath;
    });
  }

  private resolveConfiguredCustomDir(
    configuredPath: string,
  ): Effect.Effect<
    string | undefined,
    AgentDirectoriesFailed,
    FileSystem.FileSystem
  > {
    if (!configuredPath) {
      return Effect.succeed(undefined);
    }

    return Effect.gen({ self: this }, function* () {
      if (!path.isAbsolute(configuredPath)) {
        this.log.error(
          `Custom agents directory must be an absolute path: ${configuredPath}`,
        );
        yield* this.reportIssue(
          'Custom agents directory must be an absolute path',
          'custom-agents',
        );
        return undefined;
      }

      const fs = yield* FileSystem.FileSystem;
      const parentDir = path.dirname(configuredPath);
      const parentExists = yield* entryExists(fs, parentDir).pipe(
        Effect.mapError(
          this.failure(
            `Could not inspect the parent of the custom agents directory: ${parentDir}`,
          ),
        ),
      );
      if (!parentExists) {
        this.log.error(
          `Parent directory does not exist for custom agents directory: ${parentDir}`,
        );
        yield* this.reportIssue(
          'Parent directory for custom agents directory does not exist',
          'custom-agents',
        );
        return undefined;
      }

      // A regular file at the configured path must still reject here rather
      // than be handed back as a directory: `recursive` (what the provider
      // behind the facade always passed) succeeds on an existing directory
      // and fails `EEXIST` on anything else.
      yield* fs
        .makeDirectory(configuredPath, { recursive: true })
        .pipe(
          Effect.mapError(
            this.failure(
              `Unable to create the custom agents directory: ${configuredPath}`,
            ),
          ),
        );
      this.log.debug(
        `Using custom agents directory from setting: ${configuredPath}`,
      );
      return configuredPath;
    });
  }

  /** The issue reporter is a host push; its own failure is still a failed
   *  resolution, as the awaited report was. */
  private reportIssue(
    message: string,
    docsId: AgentDirectoryDocsId,
  ): Effect.Effect<void, AgentDirectoriesFailed> {
    return this.portCall(
      () => this.options.issueReporter.report(message, docsId),
      message,
    );
  }

  /** This file's one failure shape, from whatever cause raised it. */
  private failure(message: string): (cause: unknown) => AgentDirectoriesFailed {
    return (cause) =>
      new AgentDirectoriesFailed({ source: 'custom', message, cause });
  }

  /**
   * One conversion for this file's remaining promise-shaped dependency, the
   * host's issue reporter: the promise is adopted here and raised as the
   * port's failure, so the readers above compose instead of catching a
   * rejection they cannot name.
   */
  private portCall<A>(
    call: () => Promise<A>,
    message: string,
  ): Effect.Effect<A, AgentDirectoriesFailed> {
    return Effect.tryPromise({ try: call, catch: this.failure(message) });
  }
}

/**
 * The one `AgentSource` to local-directory mapping. It reads the port, not the
 * service, so every holder of an `AgentDirectoriesPort` answers a source
 * through the same three readers and gives `remote` the same verdict, instead
 * of repeating the switch at its own composition root.
 */
export function agentSourceDirectory(
  directories: AgentDirectoriesPort,
  source: AgentSource,
): Effect.Effect<
  string | undefined,
  AgentDirectoriesFailed,
  GlobalStorageFs | FileSystem.FileSystem
> {
  switch (source) {
    case 'custom':
      return directories.custom();
    case 'builtInWorkflow':
      return directories.builtIn();
    case 'builtInToolUse':
      return directories.builtInToolUse();
    // No local directory: a remote agent lives in Supabase.
    case 'remote':
      return Effect.succeed(undefined);
  }
}
