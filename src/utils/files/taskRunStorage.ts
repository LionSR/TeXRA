// Standard library imports
import * as path from 'path';
import { promises as fs } from 'fs';

import { WORKFLOW_OUTPUT_BASENAME } from '@agent/output/workflowOutputLayout';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import {
  AgentFileLocationSchema,
  ExternalFileLocationSchema,
  FileLocationSchema,
  RunStorageFileLocationSchema,
  WorkspaceFileLocationSchema,
  type AgentFileLocation,
  type ExecutionId,
  type ExternalFileLocation,
  type FileLocation,
  type RunStorageFileLocation,
  type WorkspaceFileLocation,
} from '@shared/schemas';
import { getPathSegments } from '@utils/core/pathCore';
import { StorageFS } from './storageFS';
import { WorkspaceFS } from './workspaceFS';

const CHANNEL = 'taskRunStorage';
logger.initialize(CHANNEL);

/**
 * Directory for all per-execution artifacts (KV data, debug JSONs, logs, workflow outputs, etc.).
 * NOTE: This is 'executions', NOT 'taskRuns'. Name kept for import compatibility;
 * the legacy 'taskRuns' directory is LEGACY_RUNS_DIR below.
 */
export const TASK_RUNS_DIR = 'executions';

/** Legacy directory name — checked as read fallback for pre-consolidation data. */
export const LEGACY_RUNS_DIR = 'taskRuns';

export type {
  WorkspaceFileLocation,
  RunStorageFileLocation,
  ExternalFileLocation,
  FileLocation,
  AgentFileLocation,
};

export function createWorkspaceLocation(
  absolutePath: string,
  relativePath: string,
): WorkspaceFileLocation {
  return {
    kind: 'workspace',
    absolutePath,
    relativePath,
  };
}

export function createRunStorageLocation(
  absolutePath: string,
  relativePath: string,
  executionId: ExecutionId,
): RunStorageFileLocation {
  return {
    kind: 'runStorage',
    absolutePath,
    relativePath,
    executionId,
  };
}

export function createExternalLocation(
  absolutePath: string,
): ExternalFileLocation {
  return {
    kind: 'external',
    absolutePath,
  };
}

/**
 * Get directory path from a FileLocation.
 * Returns relativePath's directory for workspace/runStorage, absolutePath's for external.
 */
export function getFileDirectory(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return path.dirname(location.relativePath);
  }
  return path.dirname(location.absolutePath);
}

/**
 * Get the full path to a specific execution's run directory.
 * @param id - The execution ID
 * @returns The full path to the run directory (always under TASK_RUNS_DIR)
 */
export function getRunDir(id: ExecutionId): string {
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id));
}

/**
 * Absolute path of the immutable pre-run snapshot for a base file. The
 * snapshot is captured by {@link TaskRunFileService.prepareRunWorkspace}
 * before any agent modifications, so diffs against it remain accurate
 * even for in-place workflows where the live workspace file has since
 * been overwritten by the agent.
 *
 * Returns the candidate path unconditionally; callers should `stat` it
 * before reading because `prepareRunWorkspace` skips files that were
 * absent or non-regular at snapshot time.
 */
export function getOriginalSnapshotPath(
  executionId: ExecutionId,
  workspaceRelativePath: string,
): string {
  return StorageFS.fullPath(
    path.join(TASK_RUNS_DIR, executionId, 'original', workspaceRelativePath),
  );
}

/**
 * Resolve a storage-relative path, checking `executions/` first then
 * legacy `taskRuns/`. Returns the storage-relative path that exists,
 * or `undefined` if neither location has the target.
 */
export async function resolveStoragePath(
  ...segments: string[]
): Promise<string | undefined> {
  const primary = path.join(TASK_RUNS_DIR, ...segments);
  if (await StorageFS.exists(primary)) return primary;
  const legacy = path.join(LEGACY_RUNS_DIR, ...segments);
  if (await StorageFS.exists(legacy)) return legacy;
  return undefined;
}

/**
 * Resolve the full filesystem path for an execution's run directory,
 * checking `executions/` first then legacy `taskRuns/`.
 * Returns `undefined` if neither location exists.
 */
export async function resolveRunDir(
  id: ExecutionId,
): Promise<string | undefined> {
  const rel = await resolveStoragePath(id);
  return rel ? StorageFS.fullPath(rel) : undefined;
}

/**
 * @internal Used internally by TaskRunFileService
 */
function getRunStoragePaths(
  id: ExecutionId,
  workspaceRelative: string,
): { absolute: string; storageRelative: string; runRelative: string } {
  const storageRelative = path.join(TASK_RUNS_DIR, id, workspaceRelative);
  return {
    absolute: StorageFS.fullPath(storageRelative),
    storageRelative,
    runRelative: workspaceRelative,
  };
}

async function ensureParentDir(filePath: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });
}

async function createSymlink(
  source: FileLocation,
  destination: string,
): Promise<void> {
  const sourceAbsolute = source.absolutePath;
  await ensureParentDir(destination);
  try {
    await fs.symlink(sourceAbsolute, destination);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.symlink(sourceAbsolute, destination);
      return;
    }
    if (
      err.code &&
      ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(err.code)
    ) {
      logger.warn(
        CHANNEL,
        `Falling back to copy ${sourceAbsolute} -> ${destination} due to ${err.code}`,
      );
      const stats = await fs.lstat(sourceAbsolute);
      if (stats.isDirectory()) {
        await fs.cp(sourceAbsolute, destination, { recursive: true });
      } else {
        await fs.copyFile(sourceAbsolute, destination);
      }
      return;
    }
    throw err;
  }
}

/**
 * Workspace-relative directories that should never be moved into run storage.
 *
 * History folders contain prior execution data that is managed separately,
 * so keep them in place even when task-run isolation is enabled.
 */
const IGNORED_WORKSPACE_ROOTS = new Set(['History', 'history']);

function shouldSkipRelocation(relativePath: string): boolean {
  const segments = getPathSegments(relativePath);
  return segments.length > 0 && IGNORED_WORKSPACE_ROOTS.has(segments[0]);
}

export class TaskRunFileService {
  public metadata: {
    executionId: ExecutionId | undefined;
    runDirectory: string | undefined;
  };
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(executionId?: ExecutionId) {
    this.metadata = {
      executionId: undefined,
      runDirectory: undefined,
    };
    this.updateRunContext(executionId);
  }

  public updateRunContext(executionId?: ExecutionId | null): void {
    const nextRunDirectory = executionId ? getRunDir(executionId) : undefined;

    const contextChanged =
      this.metadata.executionId !== executionId ||
      this.metadata.runDirectory !== nextRunDirectory;

    this.metadata.executionId = executionId ?? undefined;
    this.metadata.runDirectory = nextRunDirectory;

    if (contextChanged) {
      this.hasPreparedSnapshot = false;
      this.mirroredDependencies.clear();
    }
  }

  public getExecutionId(): ExecutionId | undefined {
    return this.metadata.executionId;
  }

  public hasRunDirectory(): boolean {
    return Boolean(this.metadata.runDirectory);
  }

  private async ensureRunDirectory(): Promise<void> {
    const executionId = this.metadata.executionId;
    if (!executionId) return;
    await ensureRunDir(executionId);
  }

  /**
   * Prepare run storage before processing begins by capturing the original
   * versions of the selected base files and mirroring any declared dependencies.
   *
   * Base files are copied into `executions/<id>/original/` as immutable snapshots
   * so the workspace can be restored even after the agent edits files in-place.
   * Additional workspace dependencies (references, auxiliaries, extracted
   * figures, etc.) are mirrored into the active run directory via symlinks so
   * tools operating inside task-run storage can resolve them using their
   * familiar workspace-relative paths.
   */
  public async prepareRunWorkspace(
    baseFiles: FileLocation[],
    options: {
      linkFiles?: FileLocation[];
      mirrorBaseFiles?: boolean;
    } = {},
  ): Promise<void> {
    const executionId = this.metadata.executionId;
    if (!executionId || this.hasPreparedSnapshot) {
      return;
    }

    await this.ensureRunDirectory();

    const linkTargets = new Set<FileLocation>(
      options.mirrorBaseFiles !== false ? baseFiles : [],
    );

    // Add extra link files, filtering out any null/undefined entries
    for (const extra of options.linkFiles ?? []) {
      if (extra) linkTargets.add(extra);
    }

    const captureTasks = baseFiles.map(async (target) => {
      if (!target || target.kind !== 'workspace') {
        return;
      }

      if (shouldSkipRelocation(target.relativePath)) {
        return;
      }

      try {
        const stats = await fs.stat(target.absolutePath);
        if (!stats.isFile()) {
          return;
        }

        const snapshotRelative = path.join('original', target.relativePath);
        const snapshotPaths = getRunStoragePaths(executionId, snapshotRelative);

        const alreadyCaptured = await fs.stat(snapshotPaths.absolute).then(
          () => true,
          (err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              throw Object.assign(
                new Error(
                  `Failed to inspect snapshot destination ${snapshotPaths.absolute}: ${err.message}`,
                ),
                { cause: err },
              );
            }
            return false;
          },
        );
        if (alreadyCaptured) return;

        await ensureParentDir(snapshotPaths.absolute);
        await fs.copyFile(target.absolutePath, snapshotPaths.absolute);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
          return;
        }
        throw Object.assign(
          new Error(
            `Failed to capture original file ${target}: ${toErrorMessage(err)}`,
          ),
          { cause: error },
        );
      }
    });

    await Promise.all(captureTasks);

    await Promise.all(
      [...linkTargets].map(async (candidate) => {
        try {
          await this.mirrorWorkspaceFile(candidate);
        } catch (error) {
          logger.warn(
            CHANNEL,
            `Failed to mirror workspace dependency ${candidate.absolutePath}: ${toErrorMessage(error)}`,
          );
        }
      }),
    );

    this.hasPreparedSnapshot = true;
  }

  /**
   * Create a FileLocation for a workflow output file. Routes to run storage
   * when an executionId is available (the normal case); falls back to the
   * workspace only when no execution context exists (e.g., ad-hoc utility
   * calls made before any run is registered).
   *
   * Accepts both absolute and workspace-relative paths. Absolute paths
   * within the workspace are converted to relative paths internally. Paths
   * outside the workspace are returned as external locations. Path
   * normalization is handled internally.
   *
   * @param inputPath - Absolute or workspace-relative path
   * @returns FileLocation (runStorage, workspace, or external)
   */
  public createLocation(inputPath: string): FileLocation {
    const resolved = WorkspaceFS.locatePath(inputPath);

    if (resolved.kind === 'external') {
      return createExternalLocation(resolved.absolutePath);
    }

    const executionId = this.metadata.executionId;
    if (executionId) {
      const runAbsolute = path.join(
        getRunDir(executionId),
        resolved.relativePath,
      );
      return createRunStorageLocation(
        runAbsolute,
        resolved.relativePath,
        executionId,
      );
    }

    return createWorkspaceLocation(
      resolved.absolutePath,
      resolved.relativePath,
    );
  }

  /**
   * Ensure a workspace dependency is reachable from run storage via symlink.
   * Takes a FileLocation and creates a symlink in run storage if needed.
   */
  public async mirrorWorkspaceFile(
    location: FileLocation,
  ): Promise<FileLocation> {
    if (location.kind !== 'workspace') {
      return location;
    }

    if (shouldSkipRelocation(location.relativePath)) {
      return location;
    }

    const executionId = this.metadata.executionId;
    if (!executionId) {
      return location;
    }

    await this.ensureRunDirectory();
    const runPaths = getRunStoragePaths(executionId, location.relativePath);

    if (!this.mirroredDependencies.has(location.relativePath)) {
      await createSymlink(location, runPaths.absolute);
      this.mirroredDependencies.add(location.relativePath);
    }

    return createRunStorageLocation(
      runPaths.absolute,
      runPaths.runRelative,
      executionId,
    );
  }

  /**
   * For every mirrored top-level dependency, ensure a symlink also exists at
   * `<runDir>/r{round}/<relativePath>`. This lets `latexmk`, `pdflatex`, and
   * `latexdiff` run with `cwd = runDir/r{round}` and resolve `\input{foo}`
   * against sibling symlinks. Idempotent; safe to call every round.
   *
   * Collisions with primary workflow artifacts are skipped:
   *   - `output.{ext}` at runDir root (the fixed round-output basename from
   *     `WORKFLOW_OUTPUT_BASENAME`).
   *   - Any existing real file at the destination — e.g. an extracted
   *     multi-document output written to `r{round}/<source>.tex` by the
   *     XML output manager when the same path is also an `\input`
   *     dependency. Replacing that real file with a symlink to the
   *     original workspace source would silently destroy the round's
   *     revised content.
   */
  public async ensureMirroredInRoundDir(round: number): Promise<void> {
    await this.ensureMirroredInRunSubdir(`r${round}`, {
      protectPrimaryOutput: true,
    });
  }

  /**
   * Ensure mirrored workspace dependencies are also reachable from
   * `<runDir>/diff/r{round}/...`, where workflow latexdiff sources and build
   * artifacts live.
   */
  public async ensureMirroredInDiffRoundDir(round: number): Promise<void> {
    await this.ensureMirroredInRunSubdir(path.join('diff', `r${round}`), {
      protectPrimaryOutput: false,
    });
  }

  private async ensureMirroredInRunSubdir(
    relativeDirectory: string,
    options: { protectPrimaryOutput: boolean },
  ): Promise<void> {
    const executionId = this.metadata.executionId;
    if (!executionId || this.mirroredDependencies.size === 0) {
      return;
    }

    const destinationSegment = relativeDirectory;
    const runDir = getRunDir(executionId);

    await Promise.all(
      [...this.mirroredDependencies].map(async (relativePath) => {
        // A dep whose path ends at `output.{ext}` (no subdirectory within the
        // round) would symlink over the primary revised output that lives at
        // `r{round}/output.{ext}`. `createSymlink` replaces any existing
        // entry on EEXIST, so an unguarded mirror would silently destroy the
        // round's result. Skip these — the dependency is still reachable at
        // `r{round}/../<relativePath>`, i.e. `<runDir>/<relativePath>`.
        const { dir: depDir, name: depName } = path.parse(relativePath);
        if (
          options.protectPrimaryOutput &&
          depDir === '' &&
          depName === WORKFLOW_OUTPUT_BASENAME
        ) {
          logger.debug(
            CHANNEL,
            `Skipping run-dir mirror of ${relativePath}: would clobber primary output in ${destinationSegment}`,
          );
          return;
        }

        const sourceAbsolute = path.join(runDir, relativePath);
        const destinationAbsolute = path.join(
          runDir,
          destinationSegment,
          relativePath,
        );

        // Guard against clobbering a real file already written to the round
        // dir — e.g. a multi-document extracted output at
        // `r{round}/chapters/ch1.tex` when `chapters/ch1.tex` is also an
        // `\input` dependency. A stale symlink from a previous call is
        // safe to replace (idempotent); anything else must be preserved.
        try {
          const stat = await fs.lstat(destinationAbsolute);
          if (!stat.isSymbolicLink()) {
            logger.debug(
              CHANNEL,
              `Skipping run-dir mirror of ${relativePath}: destination in ${destinationSegment} is an existing real file`,
            );
            return;
          }
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err?.code !== 'ENOENT') {
            logger.debug(
              CHANNEL,
              `Unable to stat ${destinationAbsolute}: ${toErrorMessage(err)}`,
            );
          }
          // ENOENT is the common case — no collision, proceed with the link.
        }

        try {
          await createSymlink(
            createRunStorageLocation(sourceAbsolute, relativePath, executionId),
            destinationAbsolute,
          );
        } catch (error) {
          logger.debug(
            CHANNEL,
            `Unable to mirror ${relativePath} into ${destinationSegment}: ${toErrorMessage(error)}`,
          );
        }
      }),
    );
  }
}

/**
 * Ensure an execution's run directory exists, creating it if necessary.
 * Also ensures the parent executions directory exists.
 * @param id - The execution ID
 */
export async function ensureRunDir(id: ExecutionId): Promise<void> {
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  await StorageFS.ensureDir(path.join(TASK_RUNS_DIR, id));
}

/**
 * Get a comparable path for file matching and mapping.
 * Returns relativePath for workspace/runStorage files, absolutePath for external files.
 */
export function getComparablePath(location: FileLocation): string {
  return location.kind === 'external'
    ? location.absolutePath
    : location.relativePath;
}

/**
 * Convert a string path to a FileLocation (standalone version).
 * Use this for utilities that don't have access to TaskRunFileService.
 * This function is NOT run-storage aware - it can only create workspace or external locations.
 * For run-storage awareness, use TaskRunFileService.createLocation() instead.
 *
 * Path normalization is handled internally - you can pass paths with either
 * forward slashes or backslashes. It's safe to pass already-normalized paths
 * (path.normalize() is idempotent).
 *
 * @param target - Absolute or workspace-relative path
 * @returns FileLocation (workspace or external, never runStorage)
 */
export function pathToLocation(target: string): FileLocation {
  const resolved = WorkspaceFS.locatePath(target);

  if (resolved.kind === 'external') {
    if (!target) {
      throw new Error('Cannot resolve empty path without workspace');
    }
    return createExternalLocation(resolved.absolutePath);
  }

  return createWorkspaceLocation(resolved.absolutePath, resolved.relativePath);
}

/**
 * Get a short display-friendly path for a file location.
 * For workspace files, returns the relative path (e.g., "logos/mpq-logo.pdf").
 * For external files, returns just the basename (not the full absolute path).
 *
 * This provides a concise human-readable path suitable for showing to users or models,
 * while absolutePath should be used for actual file operations.
 */
export function getShortDisplayPath(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath;
  }
  return path.basename(location.absolutePath);
}
