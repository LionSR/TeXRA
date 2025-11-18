// Standard library imports
import * as path from 'path';
import { promises as fs } from 'fs';

// Local imports - log
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Internal imports
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

// Local file imports
import { StorageFS } from './storageFS';
import { WorkspaceFS } from './workspaceFS';
import { AbsoluteFS } from './absoluteFS';
import { flexibleFS } from './flexibleFS';

const CHANNEL = 'taskRunStorage';
logger.initialize(CHANNEL);

/**
 * Directory name for storing task run artifacts.
 * All task execution files (debug JSONs, logs, etc.) are organized
 * in subdirectories under this parent directory.
 */
export const TASK_RUNS_DIR = 'taskRuns';

/**
 * File location in workspace with relative path.
 */
export interface WorkspaceFileLocation {
  kind: 'workspace';
  absolutePath: string;
  relativePath: string;
}

/**
 * File location in run storage with execution context.
 */
export interface RunStorageFileLocation {
  kind: 'runStorage';
  absolutePath: string;
  relativePath: string;
  executionId: string;
}

/**
 * File location outside workspace/storage (external).
 */
export interface ExternalFileLocation {
  kind: 'external';
  absolutePath: string;
}

/**
 * Discriminated union of all file location types.
 */
export type FileLocation =
  | WorkspaceFileLocation
  | RunStorageFileLocation
  | ExternalFileLocation;

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
  executionId: string,
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
 * Validate an execution ID to ensure it's safe for use in file paths.
 * Acts as a type guard to ensure the ID is defined and non-empty.
 * @param id - The execution ID to validate
 * @returns True if the ID is valid, false otherwise
 */
export function normalizeExecutionId(
  id: ExecutionId | undefined | null,
): ExecutionId | undefined {
  if (!id) return undefined;
  const normalized = id.trim().replace(/[^A-Za-z0-9_-]/g, '');
  return normalized || undefined;
}

/**
 * Get the full path to a specific task run directory.
 * @param id - The execution ID for the task run
 * @returns The full path to the task run directory
 * @throws Error if the execution ID is invalid
 */
export function getRunDir(id: ExecutionId): string {
  const safeId = normalizeExecutionId(id);
  if (!safeId) {
    throw new Error('Execution ID is required for run storage');
  }
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, safeId));
}

export function getRunStoragePaths(
  id: ExecutionId,
  workspaceRelative: string,
): { absolute: string; storageRelative: string; runRelative: string } {
  const safeId = normalizeExecutionId(id);
  if (!safeId) {
    throw new Error('Execution ID is required for run storage');
  }

  const relative = workspaceRelative ? path.normalize(workspaceRelative) : '';
  const storageRelative = path.join(TASK_RUNS_DIR, safeId, relative);
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

async function removeIfExists(target: string): Promise<void> {
  if (await AbsoluteFS.exists(target)) {
    await AbsoluteFS.delete(target, { recursive: true, useTrash: false });
  }
}

export async function moveToTarget(
  source: FileLocation,
  destination: string,
): Promise<void> {
  const resolvedSource = source.absolutePath;
  const resolvedDestination = path.resolve(destination);
  if (resolvedSource === resolvedDestination) {
    return;
  }

  await ensureParentDir(destination);

  try {
    await fs.rename(resolvedSource, resolvedDestination);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (
      err.code === 'EEXIST' ||
      err.code === 'EISDIR' ||
      err.code === 'ENOTEMPTY' ||
      err.code === 'ENOTDIR'
    ) {
      logger.warn(
        CHANNEL,
        `Replacing existing path while moving into run storage: ${resolvedDestination}`,
      );
      await fs.rm(resolvedDestination, { recursive: true, force: true });
      await fs.rename(resolvedSource, resolvedDestination);
      return;
    }

    if (err.code && err.code !== 'EXDEV') {
      throw Object.assign(
        new Error(
          `Failed to move ${resolvedSource} to ${resolvedDestination}: ${err.message}`,
        ),
        { cause: err },
      );
    }

    const stats = await fs.lstat(resolvedSource);
    if (stats.isDirectory()) {
      await fs.cp(resolvedSource, resolvedDestination, { recursive: true });
      await fs.rm(resolvedSource, { recursive: true, force: true });
      return;
    }

    await fs.copyFile(resolvedSource, resolvedDestination);
    await fs.rm(resolvedSource, { force: true });
  }
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

  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  return IGNORED_WORKSPACE_ROOTS.has(segments[0]);
}

export class TaskRunFileService {
  private useRunStorage: boolean;
  public metadata: {
    mode: 'workspace' | 'taskRunStorage';
    executionId?: ExecutionId;
    runDirectory?: string | null;
  };
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(executionId?: ExecutionId) {
    this.metadata = {
      mode: 'workspace',
      executionId: undefined,
      runDirectory: null,
    };
    this.useRunStorage = false;
    this.updateRunContext(executionId);
  }

  private applyExecutionContext(executionId?: ExecutionId | null): void {
    const storageMode = getConfig<'workspace' | 'taskRunStorage'>(
      'texra.agentOutputs.storageMode',
      'workspace',
    );
    const normalizedId = normalizeExecutionId(executionId ?? undefined);
    const shouldUseRunStorage =
      storageMode === 'taskRunStorage' && Boolean(normalizedId);

    const nextMode: 'workspace' | 'taskRunStorage' = shouldUseRunStorage
      ? 'taskRunStorage'
      : 'workspace';
    const nextRunDirectory =
      shouldUseRunStorage && normalizedId ? getRunDir(normalizedId) : null;

    const contextChanged =
      this.metadata.mode !== nextMode ||
      this.metadata.executionId !== normalizedId ||
      this.metadata.runDirectory !== nextRunDirectory;

    this.metadata.mode = nextMode;
    this.metadata.executionId = normalizedId;
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

  public isRunStorageEnabled(): boolean {
    return this.useRunStorage;
  }

  private isWithinWorkspace(candidate: string): boolean {
    const root = this.workspaceRoot;
    if (!root) return false;
    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);
    if (normalizedCandidate === normalizedRoot) return true;
    const rootWithSep = normalizedRoot.endsWith(path.sep)
      ? normalizedRoot
      : `${normalizedRoot}${path.sep}`;
    return normalizedCandidate.startsWith(rootWithSep);
  }

  private get activeExecutionId(): ExecutionId | undefined {
    return this.metadata.executionId;
  }

  public getExecutionId(): ExecutionId | undefined {
    return this.activeExecutionId;
  }

  public hasRunDirectory(): boolean {
    return Boolean(this.metadata.runDirectory);
  }

  public getRunDirectory(): string | undefined {
    return this.metadata.runDirectory ?? undefined;
  }

  public async ensureRunDirectory(): Promise<void> {
    if (!this.activeExecutionId) {
      return;
    }
    await ensureRunDir(this.activeExecutionId);
  }

  /**
   * Describe a file path as a FileLocation, with run-storage awareness.
   * Unlike standalone pathToLocation, this method can detect if an absolute path
   * is within the current run storage directory.
   *
   * @param target - Absolute or workspace-relative path
   * @returns FileLocation with appropriate kind (workspace/runStorage/external)
   */
  public describePath(target: string): FileLocation {
    if (!target) {
      return createExternalLocation(target);
    }

    // Handle relative paths: resolve to workspace
    if (!path.isAbsolute(target)) {
      const workspaceRoot = this.workspaceRoot;
      if (!workspaceRoot) {
        return createExternalLocation(target);
      }
      const normalized = path.normalize(target);
      const workspaceAbsolute = path.join(workspaceRoot, normalized);
      return createWorkspaceLocation(workspaceAbsolute, normalized);
    }

    const normalized = path.normalize(target);

    // Check if in run storage first (only relevant for this service)
    const executionId = this.activeExecutionId;
    const storageRoot = StorageFS.fullPath('');
    if (executionId && storageRoot && normalized.startsWith(storageRoot)) {
      const relativeToStorage = path.relative(storageRoot, normalized);
      const segments = relativeToStorage.split(path.sep).filter(Boolean);
      const runIndex = segments.indexOf(TASK_RUNS_DIR);

      if (runIndex !== -1 && segments.length >= runIndex + 2) {
        const runId = segments[runIndex + 1];
        if (runId === executionId) {
          const withinRun = segments.slice(runIndex + 2).join(path.sep);
          const runRelative = withinRun ? path.normalize(withinRun) : '';
          return createRunStorageLocation(normalized, runRelative, executionId);
        }
      }
    }

    // Check if in workspace
    const workspaceRoot = this.workspaceRoot;
    if (workspaceRoot) {
      const relative = path.relative(workspaceRoot, normalized);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return createWorkspaceLocation(normalized, relative);
      }
    }

    return createExternalLocation(normalized);
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
      linkFiles?: string[];
      mirrorBaseFiles?: boolean;
    } = {},
  ): Promise<void> {
    const executionId = this.activeExecutionId;
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

    const linkTargets = new Set<string>();
    const registerLink = (candidate?: string | null) => {
      if (!candidate) {
        return;
      }
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        return;
      }
      linkTargets.add(trimmed);
    };

    if (options.mirrorBaseFiles !== false) {
      for (const base of baseFiles) {
        registerLink(base.absolutePath);
      }
    }

    for (const extra of options.linkFiles ?? []) {
      registerLink(extra);
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
      const candidates = Array.from(linkTargets);
      await Promise.all(
        candidates.map(async (candidate) => {
          try {
            await this.mirrorWorkspaceFile(candidate);
          } catch (error) {
            logger.warn(
              CHANNEL,
              `Failed to mirror workspace dependency ${candidate}: ${toErrorMessage(error)}`,
            );
          }
        }),
      );
    }

    this.hasPreparedSnapshot = true;
  }

  /**
   * Get the display label (filename) from a relative path.
   * @param relativePath - Workspace-relative path
   * @returns The basename of the path
   */
  public getDisplayLabel(relativePath: string): string {
    if (!relativePath) {
      return '';
    }
    const normalized = relativePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.length === 0 ? normalized : segments.at(-1)!;
  }

  /**
   * Create a FileLocation from a workspace-relative path, with run-storage awareness.
   * This is the preferred method for creating output file locations.
   *
   * Path normalization is handled internally - you can pass paths with either
   * forward slashes or backslashes, and the function will normalize them for
   * the current platform. It's safe to pass already-normalized paths.
   *
   * @param relativePath - Workspace-relative path (e.g., "paper.tex" or "sub/paper.tex")
   * @returns FileLocation (workspace or runStorage based on current mode)
   */
  public createLocation(relativePath: string): FileLocation {
    const workspaceRoot = this.workspaceRoot;
    if (!workspaceRoot) {
      return createExternalLocation(relativePath);
    }

    // Normalize path separators for current platform (idempotent - safe to call on normalized paths)
    const normalized = relativePath ? path.normalize(relativePath) : '';
    const workspaceAbsolute = path.join(workspaceRoot, normalized);

    // Check if run storage is enabled
    const executionId = this.activeExecutionId;
    if (executionId && this.useRunStorage) {
      const runDir = this.metadata.runDirectory;
      if (runDir) {
        const runAbsolute = path.join(runDir, normalized);
        return createRunStorageLocation(runAbsolute, normalized, executionId);
      }
    }

    // Default to workspace location
    return createWorkspaceLocation(workspaceAbsolute, normalized);
  }

  /**
   * Move or mirror a workspace artifact into run storage.
   */
  public async relocateToRunStorage(
    target: string,
    options: {
      forceRunStorage?: boolean;
      keepWorkspaceCopy?: boolean;
    } = {},
  ): Promise<FileLocation> {
    const source = this.describePath(target);
    if (source.kind !== 'workspace') {
      return source;
    }

    if (shouldSkipRelocation(source.relativePath)) {
      return source;
    }

    const executionId = this.activeExecutionId;
    if (!executionId) {
      return source;
    }

    const runPaths = getRunStoragePaths(executionId, source.relativePath);
    const preferRunStorage =
      options.forceRunStorage === true || this.useRunStorage;

    if (!preferRunStorage) {
      return source;
    }

    await this.ensureRunDirectory();

    try {
      if (options.keepWorkspaceCopy) {
        await ensureParentDir(runPaths.absolute);
        await fs.copyFile(source.absolutePath, runPaths.absolute);
      } else {
        await moveToTarget(source, runPaths.absolute);
      }
    } catch (error) {
      await removeIfExists(runPaths.absolute);
      throw error;
    }

    const runLocation = createRunStorageLocation(
      runPaths.absolute,
      runPaths.runRelative,
      executionId,
    );
    const persisted = await flexibleFS.exists(runLocation);
    if (!persisted) {
      await removeIfExists(runPaths.absolute);
      throw new Error(
        `Failed to relocate ${source.absolutePath} into run storage at ${runPaths.absolute}`,
      );
    }

    return createRunStorageLocation(
      runPaths.absolute,
      runPaths.runRelative,
      executionId,
    );
  }

  /**
   * Ensure a workspace dependency is reachable from run storage via symlink.
   */
  public async mirrorWorkspaceFile(
    workspaceFile: string,
  ): Promise<FileLocation> {
    const location = this.describePath(workspaceFile);
    if (location.kind !== 'workspace') {
      return location;
    }

    if (shouldSkipRelocation(location.relativePath)) {
      return location;
    }

    const executionId = this.activeExecutionId;
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
  const safeId = normalizeExecutionId(id);
  if (!safeId) {
    throw new Error('Execution ID is required for run storage');
  }
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  await StorageFS.ensureDir(path.join(TASK_RUNS_DIR, safeId));
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
  if (!target) {
    return createExternalLocation(target);
  }

  if (!path.isAbsolute(target)) {
    const workspaceRoot = WorkspaceFS.getPath();
    if (!workspaceRoot) {
      return createExternalLocation(target);
    }
    // Normalize path separators for current platform (idempotent - safe to call on normalized paths)
    const normalized = path.normalize(target);
    const absolutePath = path.join(workspaceRoot, normalized);
    return createWorkspaceLocation(absolutePath, normalized);
  }

  // Normalize absolute path (idempotent - safe to call on normalized paths)
  const normalized = path.normalize(target);

  // Check if in workspace
  const workspaceRoot = WorkspaceFS.getPath();
  if (workspaceRoot) {
    const relative = path.relative(workspaceRoot, normalized);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return createWorkspaceLocation(normalized, relative);
    }
  }

  return createExternalLocation(normalized);
}
