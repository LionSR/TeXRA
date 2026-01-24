// Standard library imports
import * as path from 'path';
import { promises as fs } from 'fs';

// Local imports - shared schemas
import type {
  ExecutionId,
  ExternalFileLocation,
  FileLocation,
  RunStorageFileLocation,
  WorkspaceFileLocation,
} from '@shared/schemas';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Internal imports
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

// Local imports - core utilities
import { getPathSegments } from '@utils/core';

// Local file imports
import { StorageFS } from './storageFS';
import { WorkspaceFS } from './workspaceFS';

const CHANNEL = 'taskRunStorage';
logger.initialize(CHANNEL);

/** Directory for task run artifacts (debug JSONs, logs, etc.) */
export const TASK_RUNS_DIR = 'taskRuns';

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
 * Result of resolving a path against a workspace.
 * Used internally by path resolution functions.
 */
type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | { kind: 'external'; absolutePath: string };

/**
 * Resolve a path (absolute or relative) against a workspace root.
 * This is the shared logic for path resolution used by createLocation,
 * createRawOutputLocation, and pathToLocation.
 *
 * @param inputPath - Absolute or workspace-relative path
 * @param workspaceRoot - The workspace root directory (or undefined if no workspace)
 * @returns Resolved path info with kind, absolutePath, and relativePath (for workspace paths)
 */
function resolvePathAgainstWorkspace(
  inputPath: string,
  workspaceRoot: string | undefined,
): ResolvedPath {
  if (!inputPath) {
    if (!workspaceRoot) {
      return { kind: 'external', absolutePath: '' };
    }
    return { kind: 'workspace', absolutePath: workspaceRoot, relativePath: '' };
  }

  if (path.isAbsolute(inputPath)) {
    // Absolute path - check if within workspace
    // Use WorkspaceFS.relativePath() which handles symlinks correctly via
    // vscode.workspace.asRelativePath(). Direct path.relative() fails when
    // the path is inside a symlinked directory.
    if (!workspaceRoot) {
      return { kind: 'external', absolutePath: inputPath };
    }
    const relative = WorkspaceFS.relativePath(inputPath);
    if (relative !== inputPath && !relative.startsWith('..')) {
      return {
        kind: 'workspace',
        absolutePath: inputPath,
        relativePath: relative,
      };
    }
    return { kind: 'external', absolutePath: inputPath };
  }

  // Relative path
  if (!workspaceRoot) {
    return { kind: 'external', absolutePath: path.resolve(inputPath) };
  }
  const absolutePath = path.join(workspaceRoot, inputPath);
  return { kind: 'workspace', absolutePath, relativePath: inputPath };
}

/**
 * Get the full path to a specific task run directory.
 * @param id - The execution ID for the task run
 * @returns The full path to the task run directory
 */
export function getRunDir(id: ExecutionId): string {
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id));
}

/**
 * @internal Used internally by TaskRunFileService
 */
function getRunStoragePaths(
  id: ExecutionId,
  workspaceRelative: string,
): { absolute: string; storageRelative: string; runRelative: string } {
  const relative = workspaceRelative || '';
  const storageRelative = path.join(TASK_RUNS_DIR, id, relative);
  return {
    absolute: StorageFS.fullPath(storageRelative),
    storageRelative,
    runRelative: relative,
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
  if (!relativePath) {
    return false;
  }

  // Use centralized path segment extraction
  const segments = getPathSegments(relativePath);
  if (segments.length === 0) {
    return false;
  }

  return IGNORED_WORKSPACE_ROOTS.has(segments[0]);
}

export class TaskRunFileService {
  private useRunStorage: boolean;
  public metadata: {
    mode: 'workspace' | 'taskRunStorage';
    executionId: ExecutionId | undefined;
    runDirectory: string | undefined;
  };
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(executionId?: ExecutionId) {
    this.metadata = {
      mode: 'workspace',
      executionId: undefined,
      runDirectory: undefined,
    };
    this.useRunStorage = false;
    this.updateRunContext(executionId);
  }

  private applyExecutionContext(executionId?: ExecutionId | null): void {
    const storageMode = getConfig<'workspace' | 'taskRunStorage'>(
      'texra.agentOutputs.storageMode',
      'workspace',
    );
    const shouldUseRunStorage =
      storageMode === 'taskRunStorage' && Boolean(executionId);

    const nextMode: 'workspace' | 'taskRunStorage' = shouldUseRunStorage
      ? 'taskRunStorage'
      : 'workspace';
    const nextRunDirectory =
      shouldUseRunStorage && executionId ? getRunDir(executionId) : undefined;

    const contextChanged =
      this.metadata.mode !== nextMode ||
      this.metadata.executionId !== executionId ||
      this.metadata.runDirectory !== nextRunDirectory;

    this.metadata.mode = nextMode;
    this.metadata.executionId = executionId ?? undefined;
    this.metadata.runDirectory = nextRunDirectory;
    this.useRunStorage = shouldUseRunStorage;

    if (contextChanged) {
      this.hasPreparedSnapshot = false;
      this.mirroredDependencies.clear();
    }
  }

  public updateRunContext(executionId?: ExecutionId | null): void {
    this.applyExecutionContext(executionId ?? undefined);
  }

  private get workspaceRoot(): string | undefined {
    return WorkspaceFS.getPath();
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
   * Base files are copied into `taskRuns/<id>/original/` as immutable snapshots
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
    if (!executionId) {
      return;
    }

    if (!this.useRunStorage) {
      return;
    }

    if (this.hasPreparedSnapshot) {
      return;
    }

    await this.ensureRunDirectory();

    const linkTargets = new Set<FileLocation>();

    if (options.mirrorBaseFiles !== false) {
      baseFiles.forEach((base) => linkTargets.add(base));
    }

    // Add extra link files, filtering out any null/undefined entries
    for (const extra of options.linkFiles ?? []) {
      if (extra) linkTargets.add(extra);
    }

    const captureTasks = baseFiles.map(async (target) => {
      if (!target) {
        return;
      }

      const sourceLocation = target;
      if (sourceLocation.kind !== 'workspace') {
        return;
      }

      if (shouldSkipRelocation(sourceLocation.relativePath)) {
        return;
      }

      try {
        const stats = await fs.stat(sourceLocation.absolutePath);
        if (!stats.isFile()) {
          return;
        }

        const snapshotRelative = path.join(
          'original',
          sourceLocation.relativePath,
        );
        const snapshotPaths = getRunStoragePaths(executionId, snapshotRelative);

        try {
          await fs.stat(snapshotPaths.absolute);
          return;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code && err.code !== 'ENOENT') {
            throw Object.assign(
              new Error(
                `Failed to inspect snapshot destination ${snapshotPaths.absolute}: ${err.message}`,
              ),
              { cause: err },
            );
          }
        }

        await ensureParentDir(snapshotPaths.absolute);
        await fs.copyFile(sourceLocation.absolutePath, snapshotPaths.absolute);
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

    if (linkTargets.size > 0) {
      const candidates = [...linkTargets];
      await Promise.all(
        candidates.map(async (candidate) => {
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
    }

    this.hasPreparedSnapshot = true;
  }

  /**
   * Create a FileLocation for raw/intermediate output files (e.g., XML scratchpad).
   * ALWAYS routes to run storage when executionId is available, regardless of
   * the user's storageMode setting. This keeps intermediate artifacts isolated
   * from the user's workspace.
   *
   * Falls back to workspace location only when no executionId is available.
   *
   * Accepts both absolute and workspace-relative paths for robustness.
   *
   * @param inputPath - Absolute or workspace-relative path (e.g., "paper__agent__r0_model.xml")
   * @returns FileLocation (runStorage if executionId available, workspace otherwise)
   */
  public createRawOutputLocation(inputPath: string): FileLocation {
    const resolved = resolvePathAgainstWorkspace(inputPath, this.workspaceRoot);

    if (resolved.kind === 'external') {
      return createExternalLocation(resolved.absolutePath);
    }

    // Always route to run storage when executionId is available
    const executionId = this.metadata.executionId;
    if (executionId) {
      const runDir = getRunDir(executionId);
      const runAbsolute = path.join(runDir, resolved.relativePath);
      return createRunStorageLocation(
        runAbsolute,
        resolved.relativePath,
        executionId,
      );
    }

    // Fallback to workspace when no execution context
    return createWorkspaceLocation(
      resolved.absolutePath,
      resolved.relativePath,
    );
  }

  /**
   * Create a FileLocation from a path, with run-storage awareness.
   * This is the preferred method for creating output file locations.
   *
   * Accepts both absolute and workspace-relative paths. Absolute paths within
   * the workspace are automatically converted to relative paths internally.
   * Paths outside the workspace are returned as external locations.
   *
   * Path normalization is handled internally - you can pass paths with either
   * forward slashes or backslashes, and the function will normalize them for
   * the current platform. It's safe to pass already-normalized paths.
   *
   * @param inputPath - Absolute or workspace-relative path
   * @returns FileLocation (workspace, runStorage, or external based on path and mode)
   */
  public createLocation(inputPath: string): FileLocation {
    const resolved = resolvePathAgainstWorkspace(inputPath, this.workspaceRoot);

    if (resolved.kind === 'external') {
      return createExternalLocation(resolved.absolutePath);
    }

    // Check if run storage is enabled
    const executionId = this.metadata.executionId;
    if (executionId && this.useRunStorage) {
      const runDir = this.metadata.runDirectory;
      if (runDir) {
        const runAbsolute = path.join(runDir, resolved.relativePath);
        return createRunStorageLocation(
          runAbsolute,
          resolved.relativePath,
          executionId,
        );
      }
    }

    // Default to workspace location
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
}

/**
 * Ensure a task run directory exists, creating it if necessary.
 * Also ensures the parent taskRuns directory exists.
 * @param id - The execution ID for the task run
 * @throws Error if the execution ID is invalid
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
  const workspaceRoot = WorkspaceFS.getPath();

  // Special case: empty path requires workspace
  if (!target) {
    if (!workspaceRoot) {
      throw new Error('Cannot resolve empty path without workspace');
    }
    return createWorkspaceLocation(workspaceRoot, '');
  }

  const resolved = resolvePathAgainstWorkspace(target, workspaceRoot);

  if (resolved.kind === 'external') {
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
