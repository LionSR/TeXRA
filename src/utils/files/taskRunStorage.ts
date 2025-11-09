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

  throw new Error(`Cannot make path workspace-relative: ${target}`);
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

export async function moveToTarget(
  source: string,
  destination: string,
): Promise<void> {
  const resolvedSource = path.resolve(source);
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
    if (
      err.code &&
      ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(err.code)
    ) {
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
  private readonly useRunStorage: boolean;
  public readonly metadata: {
    mode: 'workspace' | 'taskRunStorage';
    executionId?: ExecutionId;
  };

  constructor(private readonly executionId?: ExecutionId) {
    const storageMode = getConfig<'workspace' | 'taskRunStorage'>(
      'texra.agentOutputs.storageMode',
      'workspace',
    );
    const useRunStorage =
      storageMode === 'taskRunStorage' && isValidExecutionId(executionId);
    this.useRunStorage = useRunStorage;
    this.metadata = {
      mode: useRunStorage ? 'taskRunStorage' : 'workspace',
      executionId: useRunStorage ? executionId : undefined,
    };
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
    if (!target) {
      return '';
    }

    if (!path.isAbsolute(target)) {
      return target;
    }

    const workspaceRoot = WorkspaceFS.getPath();
    if (!workspaceRoot) {
      return target;
    }
    const relative = path.relative(workspaceRoot, target);
    return relative.startsWith('..') || path.isAbsolute(relative)
      ? target
      : relative;
  }

  public getDisplayLabel(relativePath: string): string {
    if (!relativePath) {
      return '';
    }
    const normalized = relativePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.length === 0 ? normalized : segments[segments.length - 1];
  }

  public resolveRelativePath(
    relativePath: string,
    options?: { preferWorkspace?: boolean },
  ): {
    actual: string;
    workspace: string;
    storage: string;
  } {
    const normalized = relativePath || '';
    const workspaceRoot = WorkspaceFS.getPath();
    const workspace = path.isAbsolute(normalized)
      ? normalized
      : workspaceRoot
        ? path.join(workspaceRoot, normalized)
        : normalized;

    const storage = this.executionId
      ? StorageFS.fullPath(
          path.join(TASK_RUNS_DIR, this.executionId, normalized || ''),
        )
      : workspace;

    if (this.useRunStorage && !options?.preferWorkspace) {
      return { actual: storage, workspace, storage };
    }

    return { actual: workspace, workspace, storage };
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
    if (path.isAbsolute(target)) {
      return target;
    }

    const { actual } = this.resolveRelativePath(target);
    return actual;
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
