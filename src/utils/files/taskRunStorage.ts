// Standard library imports
import * as path from 'path';

// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { StorageFS } from './storageFS';
import { WorkspaceFS } from './workspaceFS';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

/**
 * Directory name for storing task run artifacts.
 * All task execution files (debug JSONs, logs, etc.) are organized
 * in subdirectories under this parent directory.
 */
export const TASK_RUNS_DIR = 'taskRuns';

/**
 * Validate an execution ID to ensure it's safe for use in file paths.
 * Acts as a type guard to ensure the ID is defined and non-empty.
 * @param id - The execution ID to validate
 * @returns True if the ID is valid, false otherwise
 */
export function isValidExecutionId(
  id: ExecutionId | undefined,
): id is ExecutionId {
  if (!id) return false;
  // Ensure ID doesn't contain path traversal characters or other unsafe patterns
  const invalidPatterns = ['..', '/', '\\', '\0'];
  return !invalidPatterns.some((pattern) => id.includes(pattern));
}

/**
 * Get the full path to a specific task run directory.
 * @param id - The execution ID for the task run
 * @returns The full path to the task run directory
 * @throws Error if the execution ID is invalid
 */
export function getRunDir(id: ExecutionId): string {
  if (!isValidExecutionId(id)) {
    throw new Error(`Invalid execution ID: ${id}`);
  }
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id));
}

/**
 * Ensure a task run directory exists, creating it if necessary.
 * Also ensures the parent taskRuns directory exists.
 * @param id - The execution ID for the task run
 * @throws Error if the execution ID is invalid
 */
export async function ensureRunDir(id: ExecutionId): Promise<void> {
  if (!isValidExecutionId(id)) {
    throw new Error(`Invalid execution ID: ${id}`);
  }
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  await StorageFS.ensureDir(path.join(TASK_RUNS_DIR, id));
}

/**
 * Lightweight helper for working with files persisted under a task run directory.
 */
export class TaskRunFileService {
  constructor(public readonly executionId: ExecutionId) {}

  /** Ensure that the run directory exists. */
  public async ensureBaseDir(): Promise<void> {
    await ensureRunDir(this.executionId);
  }

  /** Absolute path to the root directory for this execution. */
  public getRoot(): string {
    return getRunDir(this.executionId);
  }

  /**
   * Compute the workspace-relative path for a given workspace file.
   */
  public getRelativePath(workspacePath: string): string {
    const relative = WorkspaceFS.relativePath(workspacePath);
    return relative === '' ? path.basename(workspacePath) : relative;
  }

  private getRunRelativePath(target: string): string {
    return path.join(TASK_RUNS_DIR, this.executionId, target);
  }

  /**
   * Resolve a workspace file path to an absolute storage path inside the run directory.
   */
  public getStoragePathForWorkspaceFile(workspacePath: string): string {
    const relative = this.getRelativePath(workspacePath);
    return StorageFS.fullPath(this.getRunRelativePath(relative));
  }

  /**
   * Resolve a workspace file path to the storage directory that should contain related artifacts.
   */
  public getStorageDirForWorkspaceFile(workspacePath: string): string {
    const relative = this.getRelativePath(workspacePath);
    const relativeDir = path.dirname(relative);
    const runRelative =
      relativeDir && relativeDir !== '.'
        ? this.getRunRelativePath(relativeDir)
        : path.join(TASK_RUNS_DIR, this.executionId);
    return StorageFS.fullPath(runRelative);
  }

  /** Resolve an arbitrary relative path to an absolute path inside the run directory. */
  public getStoragePathForRelative(relativePath: string): string {
    return StorageFS.fullPath(this.getRunRelativePath(relativePath));
  }

  /** Ensure that the directory for a workspace file exists inside the run directory. */
  public async ensureDirForWorkspaceFile(workspacePath: string): Promise<void> {
    const relative = this.getRelativePath(workspacePath);
    await this.ensureDirForRelative(path.dirname(relative));
  }

  /** Ensure that a relative directory exists inside the run directory. */
  public async ensureDirForRelative(relativeDir: string): Promise<void> {
    await this.ensureBaseDir();
    if (!relativeDir || relativeDir === '.' || relativeDir === path.sep) {
      return;
    }
    await StorageFS.ensureDir(this.getRunRelativePath(relativeDir));
  }

  /**
   * Ensure a symlink exists within the run directory pointing at the workspace file.
   * Returns the absolute path to the mirrored file inside the run directory.
   */
  public async ensureWorkspaceSymlink(workspacePath: string): Promise<string> {
    const relative = this.getRelativePath(workspacePath);
    await this.ensureDirForRelative(path.dirname(relative));

    const mirrorPath = this.getStoragePathForRelative(relative);
    const mirrorDir = path.dirname(mirrorPath);
    await AbsoluteFS.ensureDir(mirrorDir);

    if (await AbsoluteFS.exists(mirrorPath)) {
      await AbsoluteFS.delete(mirrorPath, {
        recursive: false,
        useTrash: false,
      });
    }

    await AbsoluteFS.symlink(workspacePath, mirrorPath);
    return mirrorPath;
  }

  /** Determine whether a path already points inside this run directory. */
  public isInRunDir(targetPath: string): boolean {
    const normalizedRoot = this.getRoot();
    const normalizedTarget = path.resolve(targetPath);
    return normalizedTarget.startsWith(path.resolve(normalizedRoot));
  }

  /** Compute the run-relative path for a storage file. */
  public getRelativeFromStorage(storagePath: string): string {
    return path.relative(this.getRoot(), storagePath);
  }

  /** Map a storage path back to the equivalent workspace location. */
  public getWorkspacePathFromStorage(storagePath: string): string {
    const relative = this.getRelativeFromStorage(storagePath);
    return this.getWorkspacePathForRelative(relative);
  }

  /** Resolve a run-relative path to the workspace tree. */
  public getWorkspacePathForRelative(relativePath: string): string {
    const workspaceRoot = WorkspaceFS.getPath();
    return workspaceRoot
      ? path.join(workspaceRoot, relativePath)
      : relativePath;
  }
}

export function extractExecutionIdFromPath(
  filePath: string,
): ExecutionId | undefined {
  const normalized = path.normalize(filePath);
  const segments = normalized.split(path.sep);
  const index = segments.lastIndexOf(TASK_RUNS_DIR);
  if (index >= 0) {
    const candidate = segments[index + 1];
    if (candidate && isValidExecutionId(candidate as ExecutionId)) {
      return candidate as ExecutionId;
    }
  }
  return undefined;
}
