// Standard library imports
import * as path from 'path';
import { promises as fs } from 'fs';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - storage
import { StorageFS } from './storageFS';
import { WorkspaceFS } from './workspaceFS';
import { getConfig } from '@utils/config';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

const CHANNEL = 'taskRunStorage';
logger.initialize(CHANNEL);

/**
 * Directory name for storing task run artifacts.
 * All task execution files (debug JSONs, logs, etc.) are organized
 * in subdirectories under this parent directory.
 */
export const TASK_RUNS_DIR = 'taskRuns';

export type FileLocationScope = 'workspace' | 'runStorage' | 'external';

export type FileRelativeScope = 'workspace' | 'runStorage' | 'absolute';

export interface WorkspaceLocationInfo {
  absolutePath: string;
  relativePath: string;
}

export interface RunStorageLocationInfo {
  absolutePath: string;
  relativePath: string;
  storageRelativePath: string;
}

export interface FileLocation {
  absolutePath: string;
  scope: FileLocationScope;
  relativePath: string;
  relativeScope: FileRelativeScope;
  workspace?: WorkspaceLocationInfo | null;
  runStorage?: RunStorageLocationInfo | null;
}

function createFileLocation(params: {
  absolutePath: string;
  scope: FileLocationScope;
  workspace?: WorkspaceLocationInfo | null;
  runStorage?: RunStorageLocationInfo | null;
  preferredRelative?: { path: string; scope: FileRelativeScope };
}): FileLocation {
  const { absolutePath, scope, workspace, runStorage, preferredRelative } =
    params;

  const fallbackPath = workspace?.relativePath
    ? { path: workspace.relativePath, scope: 'workspace' as const }
    : runStorage?.relativePath
      ? { path: runStorage.relativePath, scope: 'runStorage' as const }
      : { path: absolutePath, scope: 'absolute' as const };

  const relative = preferredRelative ?? fallbackPath;

  return {
    absolutePath,
    scope,
    relativePath: relative.path,
    relativeScope: relative.scope,
    workspace: workspace ?? null,
    runStorage: runStorage ?? null,
  };
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
  if (!id) {
    return false;
  }

  if (id.includes('..')) {
    return false;
  }

  return /^[A-Za-z0-9._-]+$/.test(id);
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
      !relativeToWorkspace.startsWith('..') &&
      !path.isAbsolute(relativeToWorkspace)
    ) {
      return relativeToWorkspace;
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

function normalizeRunRelative(target: string): string {
  const normalized = target === '.' ? '' : target;
  if (!normalized) {
    return '';
  }
  return normalized.split(path.sep).filter(Boolean).join(path.sep);
}

export function getRunStoragePaths(
  id: ExecutionId,
  workspaceRelative: string,
): { absolute: string; storageRelative: string; runRelative: string } {
  if (!isValidExecutionId(id)) {
    throw new Error(`Invalid execution ID: ${id}`);
  }

  const relative = normalizeRunRelative(workspaceRelative);
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
      logger.warn(
        CHANNEL,
        `Falling back to copy ${source} -> ${destination} due to ${err.code}`,
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
    runDirectory?: string | null;
  };
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(private readonly executionId?: ExecutionId) {
    const storageMode = getConfig<'workspace' | 'taskRunStorage'>(
      'texra.agentOutputs.storageMode',
      'workspace',
    );
    const validExecutionId =
      executionId && isValidExecutionId(executionId) ? executionId : undefined;
    const useRunStorage =
      storageMode === 'taskRunStorage' && Boolean(validExecutionId);
    this.useRunStorage = useRunStorage;
    this.metadata = {
      mode: useRunStorage ? 'taskRunStorage' : 'workspace',
      executionId: validExecutionId,
      runDirectory:
        validExecutionId && useRunStorage ? getRunDir(validExecutionId) : null,
    };
  }

  private get workspaceRoot(): string | undefined {
    return WorkspaceFS.getPath();
  }

  private get activeExecutionId(): ExecutionId | undefined {
    return this.metadata.executionId;
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

  private resolveWorkspaceRelative(
    relativePath: string,
  ): WorkspaceLocationInfo | null {
    const root = this.workspaceRoot;
    if (!root) {
      return null;
    }
    const normalized = normalizeRunRelative(relativePath);
    const absolute =
      normalized.length === 0 ? root : path.join(root, normalized);
    return { absolutePath: absolute, relativePath: normalized };
  }

  private describeWorkspaceAbsolute(
    absolutePath: string,
  ): WorkspaceLocationInfo | null {
    const root = this.workspaceRoot;
    if (!root) {
      return null;
    }
    try {
      const relative = toWorkspaceRelative(absolutePath);
      const normalized = normalizeRunRelative(relative);
      const resolved =
        normalized.length === 0 ? root : path.join(root, normalized);
      return { absolutePath: resolved, relativePath: normalized };
    } catch {
      return null;
    }
  }

  private describeRunStorageAbsolute(
    absolutePath: string,
  ): RunStorageLocationInfo | null {
    const executionId = this.activeExecutionId;
    if (!executionId) {
      return null;
    }

    const storageRoot = StorageFS.fullPath('');
    if (!storageRoot) {
      return null;
    }

    const normalized = path.normalize(absolutePath);
    if (!normalized.startsWith(storageRoot)) {
      return null;
    }

    const relativeToStorage = path.relative(storageRoot, normalized);
    const segments = relativeToStorage.split(path.sep).filter(Boolean);
    const runIndex = segments.indexOf(TASK_RUNS_DIR);
    if (runIndex === -1 || segments.length < runIndex + 2) {
      return null;
    }

    const runId = segments[runIndex + 1];
    if (runId !== executionId) {
      return null;
    }

    const withinRun = segments.slice(runIndex + 2).join(path.sep);
    const runRelative = normalizeRunRelative(withinRun);
    const storageRelative = path.join(TASK_RUNS_DIR, executionId, runRelative);
    return {
      absolutePath: normalized,
      relativePath: runRelative,
      storageRelativePath: storageRelative,
    };
  }

  public describePath(target: string): FileLocation {
    if (!target) {
      return createFileLocation({
        absolutePath: target,
        scope: 'external',
        preferredRelative: { path: target, scope: 'absolute' },
      });
    }

    if (!path.isAbsolute(target)) {
      return this.resolveRelativePath(target, { preferWorkspace: true });
    }

    const normalized = path.normalize(target);
    const workspace = this.describeWorkspaceAbsolute(normalized);
    const runStorage = this.describeRunStorageAbsolute(normalized);
    const scope = runStorage
      ? 'runStorage'
      : workspace
        ? 'workspace'
        : 'external';

    return createFileLocation({
      absolutePath: normalized,
      scope,
      workspace,
      runStorage,
    });
  }

  /**
   * Prepare run storage before processing begins by capturing the original
   * versions of the selected base files. This keeps an immutable copy under
   * `taskRuns/<id>/original/` so the workspace can be restored even after the
   * agent edits files in-place. At present this only snapshots the explicitly
   * selected files; additional dependency linking (preambles, figures, etc.)
   * will be layered in once the agent reports those assets.
   */
  public async prepareRunWorkspace(baseFiles: string[]): Promise<void> {
    const executionId = this.activeExecutionId;
    if (!executionId) {
      return;
    }

    if (this.hasPreparedSnapshot) {
      return;
    }

    await this.ensureRunDirectory();

    const captureTasks = baseFiles.map(async (target) => {
      if (!target) {
        return;
      }

      const sourceLocation = this.describePath(target);
      const workspace = sourceLocation.workspace;
      if (!workspace) {
        return;
      }

      if (shouldSkipRelocation(workspace.relativePath)) {
        return;
      }

      try {
        const stats = await fs.stat(workspace.absolutePath);
        if (!stats.isFile()) {
          return;
        }

        const snapshotRelative = path.join('original', workspace.relativePath);
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
        await fs.copyFile(workspace.absolutePath, snapshotPaths.absolute);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
          return;
        }
        throw Object.assign(
          new Error(
            `Failed to capture original file ${target}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
          { cause: error },
        );
      }
    });

    await Promise.all(captureTasks);

    this.hasPreparedSnapshot = true;
  }

  /**
   * Convert an absolute or storage path back into a workspace-relative path.
   * @param target Path that may point to run storage or the workspace.
   */
  public getWorkspaceRelativePath(target: string): string {
    return toWorkspaceRelative(target);
  }

  public getWorkspaceDisplayPath(target: string): string {
    if (!target) {
      return '';
    }

    const location = this.describePath(target);
    if (location.workspace) {
      return location.workspace.relativePath || '';
    }

    return location.relativeScope === 'absolute'
      ? target
      : location.relativePath;
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
  ): FileLocation {
    if (path.isAbsolute(relativePath)) {
      return this.describePath(relativePath);
    }

    const workspace = this.resolveWorkspaceRelative(relativePath);
    if (!workspace) {
      const absolute = path.isAbsolute(relativePath)
        ? relativePath
        : relativePath;
      return createFileLocation({
        absolutePath: absolute,
        scope: 'external',
        preferredRelative: {
          path: relativePath,
          scope: path.isAbsolute(relativePath) ? 'absolute' : 'workspace',
        },
      });
    }

    const executionId = this.activeExecutionId;
    const runStorage = executionId
      ? getRunStoragePaths(executionId, workspace.relativePath)
      : null;

    const runInfo = runStorage
      ? {
          absolutePath: runStorage.absolute,
          relativePath: runStorage.runRelative,
          storageRelativePath: runStorage.storageRelative,
        }
      : null;

    if (runInfo && this.useRunStorage && !options?.preferWorkspace) {
      return createFileLocation({
        absolutePath: runInfo.absolutePath,
        scope: 'runStorage',
        workspace,
        runStorage: runInfo,
      });
    }

    return createFileLocation({
      absolutePath: workspace.absolutePath,
      scope: 'workspace',
      workspace,
      runStorage: runInfo,
    });
  }

  public resolveExpectedPath(target: string): string {
    return this.resolveRelativePath(target).absolutePath;
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
    const workspace = source.workspace;
    if (!workspace) {
      return source;
    }

    if (shouldSkipRelocation(workspace.relativePath)) {
      return source;
    }

    const executionId = this.activeExecutionId;
    if (!executionId) {
      return source;
    }

    const runPaths = getRunStoragePaths(executionId, workspace.relativePath);
    const runInfo: RunStorageLocationInfo = {
      absolutePath: runPaths.absolute,
      relativePath: runPaths.runRelative,
      storageRelativePath: runPaths.storageRelative,
    };

    const preferRunStorage =
      options.forceRunStorage === true || this.useRunStorage;

    if (!preferRunStorage) {
      return createFileLocation({
        absolutePath: workspace.absolutePath,
        scope: 'workspace',
        workspace,
        runStorage: runInfo,
      });
    }

    await this.ensureRunDirectory();

    if (options.keepWorkspaceCopy) {
      await ensureParentDir(runInfo.absolutePath);
      await fs.copyFile(workspace.absolutePath, runInfo.absolutePath);
    } else {
      await moveToTarget(workspace.absolutePath, runInfo.absolutePath);
    }

    return createFileLocation({
      absolutePath: runInfo.absolutePath,
      scope: 'runStorage',
      workspace,
      runStorage: runInfo,
    });
  }

  /**
   * Ensure a workspace dependency is reachable from run storage via symlink.
   */
  public async mirrorWorkspaceFile(
    workspaceFile: string,
  ): Promise<FileLocation> {
    const location = this.describePath(workspaceFile);
    const workspace = location.workspace;
    if (!workspace) {
      return location;
    }

    if (shouldSkipRelocation(workspace.relativePath)) {
      return location;
    }

    const executionId = this.activeExecutionId;
    if (!executionId) {
      return location;
    }

    await this.ensureRunDirectory();
    const runPaths = getRunStoragePaths(executionId, workspace.relativePath);
    const runInfo: RunStorageLocationInfo = {
      absolutePath: runPaths.absolute,
      relativePath: runPaths.runRelative,
      storageRelativePath: runPaths.storageRelative,
    };

    if (!this.mirroredDependencies.has(workspace.relativePath)) {
      await createSymlink(workspace.absolutePath, runInfo.absolutePath);
      this.mirroredDependencies.add(workspace.relativePath);
    }

    return createFileLocation({
      absolutePath: runInfo.absolutePath,
      scope: 'runStorage',
      workspace,
      runStorage: runInfo,
    });
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
