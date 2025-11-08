// Standard library imports
import * as path from 'path';
import { promises as fs } from 'fs';

// Local imports - storage
import { StorageFS } from './storageFS';
import { WorkspaceFS } from './workspaceFS';
import { getConfig } from '@utils/config';
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

function toWorkspaceRelative(target: string): string {
  if (!target) {
    return '';
  }

  if (!path.isAbsolute(target)) {
    return target;
  }

  const workspaceRoot = WorkspaceFS.getPath();
  if (workspaceRoot) {
    const relativeToWorkspace = path.relative(workspaceRoot, target);
    if (
      relativeToWorkspace &&
      !relativeToWorkspace.startsWith('..') &&
      !path.isAbsolute(relativeToWorkspace)
    ) {
      return relativeToWorkspace;
    }
    if (relativeToWorkspace === '') {
      return '';
    }
  }

  const storageRoot = StorageFS.fullPath('');
  const normalizedTarget = path.normalize(target);
  if (storageRoot && normalizedTarget.startsWith(storageRoot)) {
    const relativeToStorage = path.relative(storageRoot, normalizedTarget);
    const storageSegments = relativeToStorage.split(path.sep).filter(Boolean);
    const taskRunIndex = storageSegments.indexOf(TASK_RUNS_DIR);
    if (taskRunIndex >= 0) {
      const remainder = storageSegments.slice(taskRunIndex + 2);
      return remainder.length > 0 ? remainder.join(path.sep) : '';
    }
  }

  return path.basename(target);
}

export function getRunRelativePath(id: ExecutionId, target: string): string {
  if (!isValidExecutionId(id)) {
    throw new Error(`Invalid execution ID: ${id}`);
  }

  const relative = toWorkspaceRelative(target);
  const normalized = relative === '.' ? '' : relative;
  return path.join(TASK_RUNS_DIR, id, normalized);
}

export function getRunStoragePath(
  id: ExecutionId,
  target: string,
): { relative: string; absolute: string } {
  const relativePath = getRunRelativePath(id, target);
  return {
    relative: relativePath,
    absolute: StorageFS.fullPath(relativePath),
  };
}

async function ensureParentDir(filePath: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });
}

async function moveToTarget(
  source: string,
  destination: string,
): Promise<void> {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  if (resolvedSource === resolvedDestination) {
    return;
  }

  await ensureParentDir(destination);
  await fs.rm(destination, { recursive: true, force: true });

  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code && err.code !== 'EXDEV' && err.code !== 'EISDIR') {
      throw Object.assign(
        new Error(
          `Failed to move ${resolvedSource} to ${resolvedDestination}: ${err.message}`,
        ),
        { cause: err },
      );
    }

    const stats = await fs.lstat(source);
    if (stats.isDirectory()) {
      await fs.cp(source, destination, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
      return;
    }

    await fs.copyFile(source, destination);
    await fs.rm(source, { force: true });
  }
}

async function createSymlink(
  source: string,
  destination: string,
): Promise<void> {
  await ensureParentDir(destination);
  try {
    await fs.symlink(source, destination);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.symlink(source, destination);
      return;
    }
    if (err.code && ['EPERM', 'EACCES', 'EINVAL'].includes(err.code)) {
      console.debug(
        `[TaskRunFileService] Falling back to copy ${source} -> ${destination} due to ${err.code}`,
      );
      const stats = await fs.lstat(source);
      if (stats.isDirectory()) {
        await fs.cp(source, destination, { recursive: true });
      } else {
        await fs.copyFile(source, destination);
      }
      return;
    }
    throw err;
  }
}

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
  private readonly useRunStorage: boolean;

  constructor(private readonly executionId?: ExecutionId) {
    const storageMode = getConfig<'workspace' | 'taskRunStorage'>(
      'texra.agentOutputs.storageMode',
      'workspace',
    );
    this.useRunStorage =
      storageMode === 'taskRunStorage' && isValidExecutionId(executionId);
  }

  public hasRunDirectory(): boolean {
    return this.useRunStorage;
  }

  public getRunDirectory(): string | undefined {
    if (!this.executionId || !this.useRunStorage) {
      return undefined;
    }
    return getRunDir(this.executionId);
  }

  public async ensureRunDirectory(): Promise<void> {
    if (!this.executionId || !this.useRunStorage) {
      return;
    }
    await ensureRunDir(this.executionId);
  }

  public getWorkspaceDisplayPath(target: string): string {
    const absolute = path.isAbsolute(target)
      ? target
      : WorkspaceFS.fullPath(target);
    const workspaceRoot = WorkspaceFS.getPath();
    if (!workspaceRoot) {
      return absolute;
    }
    return path.relative(workspaceRoot, absolute);
  }

  public async relocateToRunStorage(target: string): Promise<{
    storagePath: string;
    workspacePath: string;
    relativePath: string;
  }> {
    const absoluteSource = path.isAbsolute(target)
      ? target
      : WorkspaceFS.getPath()
        ? WorkspaceFS.fullPath(target)
        : target;
    const workspaceRelative = toWorkspaceRelative(absoluteSource);

    if (shouldSkipRelocation(workspaceRelative)) {
      return {
        storagePath: absoluteSource,
        workspacePath: absoluteSource,
        relativePath: workspaceRelative,
      };
    }

    if (!this.executionId || !this.useRunStorage) {
      return {
        storagePath: absoluteSource,
        workspacePath: absoluteSource,
        relativePath: workspaceRelative,
      };
    }

    await this.ensureRunDirectory();
    const { absolute } = getRunStoragePath(this.executionId, absoluteSource);
    await moveToTarget(absoluteSource, absolute);
    return {
      storagePath: absolute,
      workspacePath: absoluteSource,
      relativePath: workspaceRelative,
    };
  }

  public async mirrorWorkspaceFile(workspaceFile: string): Promise<{
    storagePath: string;
    workspacePath: string;
  }> {
    const absoluteSource = path.isAbsolute(workspaceFile)
      ? workspaceFile
      : WorkspaceFS.getPath()
        ? WorkspaceFS.fullPath(workspaceFile)
        : workspaceFile;

    if (!this.executionId || !this.useRunStorage) {
      return {
        storagePath: absoluteSource,
        workspacePath: absoluteSource,
      };
    }

    await this.ensureRunDirectory();
    const { absolute } = getRunStoragePath(this.executionId, absoluteSource);
    await createSymlink(absoluteSource, absolute);
    return {
      storagePath: absolute,
      workspacePath: absoluteSource,
    };
  }

  public resolveExpectedPath(target: string): string {
    const absoluteSource = path.isAbsolute(target)
      ? target
      : WorkspaceFS.getPath()
        ? WorkspaceFS.fullPath(target)
        : target;

    if (!this.executionId || !this.useRunStorage) {
      return absoluteSource;
    }

    const { absolute } = getRunStoragePath(this.executionId, absoluteSource);
    return absolute;
  }
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
