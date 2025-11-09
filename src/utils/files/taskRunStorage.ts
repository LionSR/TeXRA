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

export interface TaskRunSessionMetadata {
  storageMode: 'workspace' | 'taskRunStorage';
  runDirectory?: string | null;
  runRelativeRoot?: string | null;
}

export interface TaskRunFileDescriptor {
  actualPath: string;
  workspacePath?: string | null;
  workspaceRelative?: string | null;
  runStoragePath?: string | null;
  runRelative?: string | null;
  displayPath: string;
}

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

function tryMakeWorkspaceRelative(target: string): string | null {
  try {
    const relative = toWorkspaceRelative(target);
    return relative;
  } catch {
    return null;
  }
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

  try {
    await fs.rename(resolvedSource, resolvedDestination);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'EEXIST') {
      await fs.rm(resolvedDestination, { recursive: true, force: true });
      await fs.rename(resolvedSource, resolvedDestination);
      return;
    }

    if (err.code && err.code !== 'EXDEV' && err.code !== 'EISDIR') {
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

async function recreateWorkspaceLink(
  originalPath: string,
  storagePath: string,
): Promise<void> {
  const workspaceRoot = WorkspaceFS.getPath();
  if (!workspaceRoot) {
    return;
  }

  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedOriginal = path.resolve(originalPath);
  const relativeToWorkspace = path.relative(
    normalizedWorkspaceRoot,
    normalizedOriginal,
  );
  if (
    relativeToWorkspace.startsWith('..') ||
    path.isAbsolute(relativeToWorkspace)
  ) {
    return;
  }

  try {
    await createSymlink(storagePath, originalPath);
  } catch (error) {
    console.warn(
      `[TaskRunFileService] Failed to mirror ${storagePath} back to ${originalPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  private readonly storageMode: 'workspace' | 'taskRunStorage';
  private readonly useRunStorage: boolean;

  constructor(private readonly executionId?: ExecutionId) {
    this.storageMode = getConfig<'workspace' | 'taskRunStorage'>(
      'texra.agentOutputs.storageMode',
      'workspace',
    );
    this.useRunStorage =
      this.storageMode === 'taskRunStorage' && isValidExecutionId(executionId);
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

  public getSessionMetadata(): TaskRunSessionMetadata {
    if (!this.executionId || !this.useRunStorage) {
      return { storageMode: this.storageMode };
    }

    return {
      storageMode: this.storageMode,
      runDirectory: getRunDir(this.executionId),
      runRelativeRoot: path.join(TASK_RUNS_DIR, this.executionId),
    };
  }

  public async ensureRunDirectory(): Promise<void> {
    if (!this.executionId || !this.useRunStorage) {
      return;
    }
    await ensureRunDir(this.executionId);
  }

  private resolveAbsolute(target: string): string {
    if (path.isAbsolute(target)) {
      return path.resolve(target);
    }

    const workspaceRoot = WorkspaceFS.getPath();
    if (workspaceRoot) {
      return path.resolve(WorkspaceFS.fullPath(target));
    }

    return path.resolve(target);
  }

  private describeLocation(
    actualPath: string,
    workspacePath?: string | null,
  ): TaskRunFileDescriptor {
    const normalizedActual = path.resolve(actualPath);
    const normalizedWorkspace = workspacePath
      ? path.resolve(workspacePath)
      : undefined;

    const workspaceRelative = normalizedWorkspace
      ? tryMakeWorkspaceRelative(normalizedWorkspace)
      : tryMakeWorkspaceRelative(normalizedActual);

    let runStoragePath: string | null = null;
    let runRelative: string | null = null;

    if (this.executionId && this.useRunStorage) {
      const storageRoot = path.resolve(StorageFS.fullPath(''));
      const inStorage =
        normalizedActual === storageRoot ||
        normalizedActual.startsWith(`${storageRoot}${path.sep}`);

      if (inStorage) {
        runStoragePath = normalizedActual;
        runRelative = tryMakeWorkspaceRelative(normalizedActual);
      }
    }

    const displayPath =
      workspaceRelative ??
      (runRelative && this.executionId
        ? path.join(TASK_RUNS_DIR, this.executionId, runRelative)
        : normalizedActual);

    return {
      actualPath: normalizedActual,
      workspacePath: normalizedWorkspace ?? null,
      workspaceRelative,
      runStoragePath,
      runRelative,
      displayPath,
    };
  }

  public getWorkspaceDisplayPath(target: string): string {
    const descriptor = this.describeLocation(this.resolveAbsolute(target));
    return descriptor.displayPath;
  }

  public async relocateToRunStorage(
    target: string,
  ): Promise<TaskRunFileDescriptor> {
    const absoluteSource = this.resolveAbsolute(target);
    const workspaceRelative = tryMakeWorkspaceRelative(absoluteSource) ?? '';

    if (shouldSkipRelocation(workspaceRelative)) {
      return this.describeLocation(absoluteSource, absoluteSource);
    }

    if (!this.executionId || !this.useRunStorage) {
      return this.describeLocation(absoluteSource, absoluteSource);
    }

    await this.ensureRunDirectory();
    const { absolute } = getRunStoragePath(this.executionId, absoluteSource);
    const resolvedSource = path.resolve(absoluteSource);
    await moveToTarget(resolvedSource, absolute);
    if (resolvedSource !== absolute) {
      await recreateWorkspaceLink(resolvedSource, absolute);
    }
    return this.describeLocation(absolute, resolvedSource);
  }

  public async mirrorWorkspaceFile(
    workspaceFile: string,
  ): Promise<TaskRunFileDescriptor> {
    const absoluteSource = this.resolveAbsolute(workspaceFile);

    if (!this.executionId || !this.useRunStorage) {
      return this.describeLocation(absoluteSource, absoluteSource);
    }

    await this.ensureRunDirectory();
    const { absolute } = getRunStoragePath(this.executionId, absoluteSource);
    await createSymlink(absoluteSource, absolute);
    return this.describeLocation(absolute, absoluteSource);
  }

  public resolveExpectedPath(target: string): string {
    const absoluteSource = this.resolveAbsolute(target);

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
