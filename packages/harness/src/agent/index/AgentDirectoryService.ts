// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';

// Local imports
import { CUSTOM_AGENTS_STORAGE_DIR } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentDirectories,
  AgentDirectoriesFailed,
  type AgentDirectoriesPort,
  type AppState,
  type StateReadFailed,
  type StateStore,
} from '@platform/interfaces';
import { GlobalStorageFs } from '@platform/rootedFs';
import { Settings } from '@shared/config/settings';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { AgentSource } from '@shared/schemas';
import type { ToolRegistry } from '@tools/toolTable';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { entryExists } from '@utils/files/fsEntryExists';

import {
  BUNDLED_AGENTS_DIRECTORY,
  enabledBuiltInRoots,
} from './BundledAgentDirectories';
import type { AgentEntry } from './agentEntry';

/**
 * The custom agent directory the user configured, trimmed; empty when none is
 * (the host then uses its default directory).
 */
export const readCustomAgentDir = (
  state: Pick<StateStore, 'get'>,
): Effect.Effect<string, StateReadFailed> =>
  Settings.state(
    state,
    GlobalStateKey.CUSTOM_AGENT_DIR,
    Schema.Trim.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  );

/** What a host's agent directories are built from. */
export interface AgentDirectoryServiceOptions {
  channel: string;
  /**
   * Packaged resources root holding the bundled agent directories. Hosts read
   * their built-in agents straight out of the bundle they shipped with, so one
   * host's install can never overwrite another's built-ins.
   */
  resourcesPath: string;
  /** Where the configured custom agent directory is read from. */
  state: Pick<StateStore, 'get'>;
  /** Defaults to logging the issue at `warn`; hosts with an interactive
   * notification surface (e.g. the VS Code extension) can override it. */
  issueReporter?: {
    report(message: string, docsId: 'custom-agents'): Effect.Effect<void>;
  };
}

export class AgentDirectoryService {
  readonly resourcesRoot?: string;

  constructor(private readonly options: AgentDirectoryServiceOptions) {
    if (options.resourcesPath !== '')
      this.resourcesRoot = options.resourcesPath;
  }

  /**
   * The bundled agent directory itself. It ships read-only with the host
   * and every consumer registers it `writable: false`, so there is nothing
   * to create.
   */
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed> {
    return Effect.suspend(() => {
      const basePath = path.join(
        this.options.resourcesPath,
        BUNDLED_AGENTS_DIRECTORY,
      );
      return Effect.logDebug(
        `Using built-in ${BUNDLED_AGENTS_DIRECTORY} directory: ${basePath}`,
      ).pipe(withLogChannel(this.options.channel), Effect.as(basePath));
    });
  }

  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      const configuredPath = yield* this.configuredCustomPath();
      const resolvedPath =
        yield* this.resolveConfiguredCustomDir(configuredPath);
      if (resolvedPath != null) return resolvedPath;
      return yield* this.ensureDefaultCustomDir();
    });
  }

  /** Whether `custom` resolves to the configured directory: the same
   *  validation, so a configured path it would reject (relative, or with a
   *  missing parent) reports its issue here and answers `false`. */
  customConfigured(): Effect.Effect<
    boolean,
    AgentDirectoriesFailed,
    FileSystem.FileSystem
  > {
    return this.configuredCustomPath().pipe(
      Effect.flatMap((configured) =>
        this.resolveConfiguredCustomDir(configured),
      ),
      Effect.map((resolved) => resolved != null),
    );
  }

  /** The custom directory setting, trimmed; empty when none is configured. */
  private configuredCustomPath(): Effect.Effect<
    string,
    AgentDirectoriesFailed
  > {
    return readCustomAgentDir(this.options.state).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDirectoriesFailed({
            source: 'custom',
            message: cause.message,
            cause,
          }),
      ),
    );
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
          Effect.catch((cause) =>
            Effect.logError(
              'Failed to create default custom agents directory',
            ).pipe(
              Effect.annotateLogs({ data: cause }),
              withLogChannel(this.options.channel),
              Effect.andThen(
                Effect.fail(
                  new AgentDirectoriesFailed({
                    source: 'custom',
                    message:
                      'Unable to create custom agents directory. Please check permissions.',
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      yield* Effect.logDebug(
        `Using default custom agents directory: ${defaultPath}`,
      ).pipe(withLogChannel(this.options.channel));
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
        yield* Effect.logError(
          `Custom agents directory must be an absolute path: ${configuredPath}`,
        ).pipe(withLogChannel(this.options.channel));
        yield* this.reportIssue(
          'Custom agents directory must be an absolute path',
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
        yield* Effect.logError(
          `Parent directory does not exist for custom agents directory: ${parentDir}`,
        ).pipe(withLogChannel(this.options.channel));
        yield* this.reportIssue(
          'Parent directory for custom agents directory does not exist',
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
      yield* Effect.logDebug(
        `Using custom agents directory from setting: ${configuredPath}`,
      ).pipe(withLogChannel(this.options.channel));
      return configuredPath;
    });
  }

  /** The issue reporter is a host push with a never error channel, so
   *  reporting an issue cannot fail the resolution that raised it. */
  private reportIssue(message: string): Effect.Effect<void> {
    if (this.options.issueReporter) {
      return this.options.issueReporter.report(message, 'custom-agents');
    }
    return Effect.logWarning(
      `${message}. See documentation: custom-agents`,
    ).pipe(withLogChannel(this.options.channel));
  }

  /** This file's one failure shape, from whatever cause raised it. */
  private failure(message: string): (cause: unknown) => AgentDirectoriesFailed {
    return (cause) =>
      new AgentDirectoriesFailed({ source: 'custom', message, cause });
  }
}

/**
 * The one `AgentSource` to local-directories mapping, read off the port so
 * every holder of an `AgentDirectoriesPort` answers a source the same way,
 * the catalog's scan included: the custom directory, or the bundled
 * directory, then each tool plugin's that is on (an off plugin contributes
 * nothing). A plugin agent has none: it
 * lives in its own plugin's.
 */
export function agentSourceRoots(
  directories: AgentDirectoriesPort,
  source: AgentSource,
): Effect.Effect<
  readonly string[],
  AgentDirectoriesFailed | StateReadFailed,
  GlobalStorageFs | FileSystem.FileSystem | AppState | ToolRegistry
> {
  switch (source) {
    case 'custom':
      return Effect.map(directories.custom(), (dir) => [dir]);
    case 'builtIn':
      return Effect.flatMap(directories.builtIn(), (core) =>
        enabledBuiltInRoots(core, directories.resourcesRoot),
      );
    case 'plugin':
    case 'inline':
      return Effect.succeed([]);
  }
}

// Customized copies of bundled agents. A copy lands in the custom agents
// directory stamped with `basedOn`, the digest of the bundled file it was
// taken from, so the catalog can tell when an app update ships a newer
// bundled version (`AgentCatalog.newerBuiltIn`). Every host's "customize"
// and "keep mine" write through `AgentCatalog.customize`.

/**
 * `customize` refused the change: the entry has no file of its own to copy
 * (`noFile`), its copy would land outside the custom directory (`escapes`),
 * a copy is already there (`exists`, at `path`), or a copy has no newer
 * bundled version to keep (`current`).
 */
export class AgentCustomizeRefused extends Schema.TaggedError<AgentCustomizeRefused>()(
  'AgentCustomizeRefused',
  {
    reason: Schema.Literals(['noFile', 'escapes', 'exists', 'current']),
    path: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

/**
 * A change to a custom copy of a bundled agent: `copy` writes a new one
 * into the custom directory, stamped with the bundled file's digest
 * (`basedOn`), and is refused when one is there; `overwrite` replaces it;
 * `keep` re-stamps the user's copy with the changed bundled version, which
 * dismisses its newer-version notice and touches nothing else.
 */
export type AgentCustomization = 'copy' | 'overwrite' | 'keep';

/**
 * Write the definition at `from` to `to`, recording `digest` as the bundled
 * version it is based on. `basedOn` is a top-level key, so any earlier stamp
 * line is replaced rather than repeated.
 */
const writeStampedCopy = Effect.fn('writeStampedCopy')(function* (
  from: string,
  to: string,
  digest: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = (yield* fs.readFileString(from)).replace(/^basedOn:.*\n?/m, '');
  yield* fs.makeDirectory(path.dirname(to), { recursive: true });
  yield* fs.writeFileString(
    to,
    `${text.endsWith('\n') ? text : `${text}\n`}basedOn: ${digest} # the bundled version this copy started from\n`,
  );
});

/** Where a copy of `entry` lands: its path relative to the source root
 *  that holds it, under the custom directory; undefined when that escapes. */
const copyTarget = Effect.fn('AgentDirectoryService.copyTarget')(function* (
  entry: AgentEntry,
) {
  const directories = yield* AgentDirectories;
  const [customDir, sourceRoots] = yield* Effect.all(
    [directories.custom(), agentSourceRoots(directories, entry.source)],
    { concurrency: 'unbounded' },
  );
  const sourceRoot = sourceRoots.find((root) =>
    isStrictlyWithin(root, entry.path),
  );
  const target = path.join(
    customDir,
    sourceRoot
      ? path.relative(sourceRoot, entry.path)
      : path.basename(entry.path),
  );
  return isStrictlyWithin(customDir, target) ? target : undefined;
});

/** Apply `change` to the custom copy of `entry`; `newerBuiltIn` is the
 *  changed bundled version a `keep` re-stamps with. The copy's path. */
export const customizeCopy = Effect.fn('customizeCopy')(function* (
  entry: AgentEntry,
  change: AgentCustomization,
  newerBuiltIn: AgentEntry | undefined,
) {
  // The bundled version the copy is stamped with.
  const base = change === 'keep' ? newerBuiltIn : entry;
  if (base?.digest == null || entry.path === '')
    return yield* new AgentCustomizeRefused(
      change === 'keep'
        ? {
            reason: 'current',
            message: `${entry.name} has no newer built-in version to dismiss.`,
          }
        : { reason: 'noFile', message: `${entry.name} has no file to copy.` },
    );
  const target = change === 'keep' ? entry.path : yield* copyTarget(entry);
  if (target === undefined)
    return yield* new AgentCustomizeRefused({
      reason: 'escapes',
      message: 'Refusing to copy: target escapes the custom agents directory.',
    });
  const fs = yield* FileSystem.FileSystem;
  if (change === 'copy' && (yield* fs.exists(target)))
    return yield* new AgentCustomizeRefused({
      reason: 'exists',
      path: target,
      message: `A custom copy already exists: ${target}`,
    });
  yield* writeStampedCopy(entry.path, target, base.digest);
  return target;
});
