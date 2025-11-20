// Standard library imports
import * as path from 'path';
import { promises as fs } from 'fs';

// Third-party imports
import * as vscode from 'vscode';

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
  absoluteUri: vscode.Uri;
  readonly absolutePath: string;
  readonly relativePath: string;
}

/**
 * File location in run storage with execution context.
 */
export interface RunStorageFileLocation {
  kind: 'runStorage';
  absoluteUri: vscode.Uri;
  readonly absolutePath: string;
  readonly relativePath: string;
  executionId: string;
}

/**
 * File location outside workspace/storage (external).
 */
export interface ExternalFileLocation {
  kind: 'external';
  absoluteUri: vscode.Uri;
  readonly absolutePath: string;
}

/**
 * Discriminated union of all file location types.
 */
export type FileLocation =
  | WorkspaceFileLocation
  | RunStorageFileLocation
  | ExternalFileLocation;

/**
 * Agent outputs are always workspace or runStorage, never external.
 * Use this type for agent-created file locations.
 */
export type AgentFileLocation = WorkspaceFileLocation | RunStorageFileLocation;

type LocationParams =
  | { kind: 'workspace'; absoluteUri: vscode.Uri; baseUri: vscode.Uri }
  | {
      kind: 'runStorage';
      absoluteUri: vscode.Uri;
      baseUri: vscode.Uri;
      executionId: string;
    }
  | { kind: 'external'; absoluteUri: vscode.Uri };

function relativeFromBase(
  absoluteUri: vscode.Uri,
  baseUri: vscode.Uri,
): string {
  return path.relative(baseUri.fsPath, absoluteUri.fsPath);
}

function createFileLocation(params: LocationParams): FileLocation {
  const { absoluteUri } = params;

  const base = {
    absoluteUri,
    get absolutePath() {
      return absoluteUri.fsPath;
    },
  };

  if (params.kind === 'external') {
    return { ...base, kind: params.kind } satisfies ExternalFileLocation;
  }

  if (params.kind === 'workspace') {
    return {
      ...base,
      kind: params.kind,
      get relativePath() {
        return relativeFromBase(absoluteUri, params.baseUri);
      },
    } satisfies WorkspaceFileLocation;
  }

  return {
    ...base,
    kind: params.kind,
    executionId: params.executionId,
    get relativePath() {
      return relativeFromBase(absoluteUri, params.baseUri);
    },
  } satisfies RunStorageFileLocation;
}

export function createWorkspaceLocation(
  absoluteUri: vscode.Uri,
  baseUri: vscode.Uri,
): WorkspaceFileLocation {
  return createFileLocation({
    kind: 'workspace',
    absoluteUri,
    baseUri,
  }) as WorkspaceFileLocation;
}

export function createRunStorageLocation(
  absoluteUri: vscode.Uri,
  baseUri: vscode.Uri,
  executionId: string,
): RunStorageFileLocation {
  return createFileLocation({
    kind: 'runStorage',
    absoluteUri,
    baseUri,
    executionId,
  }) as RunStorageFileLocation;
}

export function createExternalLocation(
  absoluteUri: vscode.Uri,
): ExternalFileLocation {
  return createFileLocation({
    kind: 'external',
    absoluteUri,
  }) as ExternalFileLocation;
}

/**
 * Get the full path to a specific task run directory.
 * @param id - The execution ID for the task run
 * @returns The full path to the task run directory
 */
export function getRunDir(id: ExecutionId): vscode.Uri {
  const runRoot = StorageFS.fullUri(TASK_RUNS_DIR);
  return vscode.Uri.joinPath(runRoot, id);
}

/**
 * @internal Used internally by TaskRunFileService
 */
function getRunStoragePaths(
  id: ExecutionId,
  workspaceRelative: string | string[],
): { absolute: vscode.Uri; runRoot: vscode.Uri } {
  const segments = Array.isArray(workspaceRelative)
    ? workspaceRelative.filter(Boolean)
    : workspaceRelative.replace(/\\/g, '/').split('/').filter(Boolean);
  const runRoot = getRunDir(id);
  const absolute =
    segments.length > 0 ? vscode.Uri.joinPath(runRoot, ...segments) : runRoot;

  return {
    absolute,
    runRoot,
  };
}

async function ensureParentDir(filePath: vscode.Uri): Promise<void> {
  const parentDir = vscode.Uri.file(path.dirname(filePath.fsPath));
  await AbsoluteFS.ensureDir(parentDir);
}

async function removeIfExists(target: vscode.Uri): Promise<void> {
  if (await AbsoluteFS.exists(target)) {
    await AbsoluteFS.delete(target, { recursive: true, useTrash: false });
  }
}

async function createSymlink(
  source: FileLocation,
  destination: vscode.Uri,
): Promise<void> {
  const sourceAbsolute = source.absoluteUri.fsPath;
  await ensureParentDir(destination);
  try {
    await fs.symlink(sourceAbsolute, destination.fsPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      await fs.rm(destination.fsPath, { recursive: true, force: true });
      await fs.symlink(sourceAbsolute, destination.fsPath);
      return;
    }
    if (
      err.code &&
      ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(err.code)
    ) {
      logger.warn(
        CHANNEL,
        `Falling back to copy ${sourceAbsolute} -> ${destination.fsPath} due to ${err.code}`,
      );
      const stats = await fs.lstat(sourceAbsolute);
      if (stats.isDirectory()) {
        await fs.cp(sourceAbsolute, destination.fsPath, { recursive: true });
      } else {
        await fs.copyFile(sourceAbsolute, destination.fsPath);
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

  const [first] = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return first ? IGNORED_WORKSPACE_ROOTS.has(first) : false;
}

export class TaskRunFileService {
  private runContext: {
    mode: 'workspace' | 'taskRunStorage';
    executionId?: ExecutionId;
    runDirectory?: vscode.Uri;
  };
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(executionId?: ExecutionId) {
    this.runContext = {
      mode: 'workspace',
      executionId: undefined,
      runDirectory: undefined,
    };
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
      this.runContext.mode !== nextMode ||
      this.runContext.executionId !== executionId ||
      this.runContext.runDirectory !== nextRunDirectory;

    this.runContext = {
      mode: nextMode,
      executionId: executionId ?? undefined,
      runDirectory: nextRunDirectory,
    };

    if (contextChanged) {
      this.hasPreparedSnapshot = false;
      this.mirroredDependencies.clear();
    }
  }

  public updateRunContext(executionId?: ExecutionId | null): void {
    this.applyExecutionContext(executionId ?? undefined);
  }

  private get isRunStorageMode(): boolean {
    return this.runContext.mode === 'taskRunStorage';
  }

  private get workspaceRoot(): vscode.Uri | undefined {
    return WorkspaceFS.getUri();
  }

  // Direct access to activeExecutionId for internal use
  private get activeExecutionId(): ExecutionId | undefined {
    return this.runContext.executionId;
  }

  public getExecutionId(): ExecutionId | undefined {
    return this.runContext.executionId;
  }

  public hasRunDirectory(): boolean {
    return Boolean(this.runContext.runDirectory);
  }

  private async ensureRunDirectory(): Promise<void> {
    if (!this.activeExecutionId) {
      return;
    }
    await ensureRunDir(this.activeExecutionId);
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

    if (!this.isRunStorageMode) {
      return;
    }

    if (this.hasPreparedSnapshot) {
      return;
    }

    await this.ensureRunDirectory();

    const linkTargets = new Set<FileLocation>();
    const workspaceRoot = this.workspaceRoot;
    if (!workspaceRoot) {
      return;
    }

    const registerLink = (candidate?: string | null) => {
      if (!candidate) {
        return;
      }
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        return;
      }
      // Resolve relative paths against workspace root
      const candidateUri = path.isAbsolute(trimmed)
        ? vscode.Uri.file(trimmed)
        : vscode.Uri.joinPath(workspaceRoot, trimmed);
      linkTargets.add(createWorkspaceLocation(candidateUri, workspaceRoot));
    };

    if (options.mirrorBaseFiles !== false) {
      // Use baseFiles directly - they're already FileLocations
      for (const base of baseFiles) {
        linkTargets.add(base);
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
        const stats = await fs.stat(sourceLocation.absoluteUri.fsPath);
        if (!stats.isFile()) {
          return;
        }

        const snapshotSegments = [
          'original',
          ...sourceLocation.relativePath
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean),
        ];
        const snapshotPaths = getRunStoragePaths(executionId, snapshotSegments);

        try {
          await fs.stat(snapshotPaths.absolute.fsPath);
          return;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code && err.code !== 'ENOENT') {
            throw Object.assign(
              new Error(
                `Failed to inspect snapshot destination ${snapshotPaths.absolute.fsPath}: ${err.message}`,
              ),
              { cause: err },
            );
          }
        }

        await ensureParentDir(snapshotPaths.absolute);
        await fs.copyFile(
          sourceLocation.absoluteUri.fsPath,
          snapshotPaths.absolute.fsPath,
        );
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
              `Failed to mirror workspace dependency ${candidate.absolutePath}: ${toErrorMessage(error)}`,
            );
          }
        }),
      );
    }

    this.hasPreparedSnapshot = true;
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
      const absolute = path.isAbsolute(relativePath)
        ? vscode.Uri.file(path.normalize(relativePath))
        : vscode.Uri.file(path.resolve(relativePath));
      return createExternalLocation(absolute);
    }

    // Normalize path separators for current platform (idempotent - safe to call on normalized paths)
    const normalized = relativePath ? path.normalize(relativePath) : '';
    const segments = normalized.split(/\\|\//).filter(Boolean);
    const workspaceAbsolute =
      segments.length > 0
        ? vscode.Uri.joinPath(workspaceRoot, ...segments)
        : workspaceRoot;

    // Check if run storage is enabled
    const executionId = this.activeExecutionId;
    if (executionId && this.isRunStorageMode) {
      const runDir = this.runContext.runDirectory;
      if (runDir) {
        const runAbsolute =
          segments.length > 0
            ? vscode.Uri.joinPath(runDir, ...segments)
            : runDir;
        return createRunStorageLocation(runAbsolute, runDir, executionId);
      }
    }

    // Default to workspace location
    return createWorkspaceLocation(workspaceAbsolute, workspaceRoot);
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
      runPaths.runRoot,
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
  await StorageFS.ensureDir(
    vscode.Uri.joinPath(StorageFS.fullUri(TASK_RUNS_DIR), id),
  );
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
export function pathToLocation(target: string | vscode.Uri): FileLocation {
  if (!target) {
    const workspaceRoot = WorkspaceFS.getUri();
    if (!workspaceRoot) {
      throw new Error('Cannot resolve empty path without workspace');
    }
    return createWorkspaceLocation(workspaceRoot, workspaceRoot);
  }

  if (target instanceof vscode.Uri) {
    const workspaceRoot = WorkspaceFS.getUri();
    if (workspaceRoot) {
      const relative = WorkspaceFS.relativePath(target);
      const workspaceCandidate = path.isAbsolute(relative)
        ? undefined
        : relative;
      if (workspaceCandidate !== undefined && !relative.startsWith('..')) {
        return createWorkspaceLocation(target, workspaceRoot);
      }
    }
    return createExternalLocation(target);
  }

  if (!path.isAbsolute(target)) {
    const workspaceRoot = WorkspaceFS.getUri();
    if (!workspaceRoot) {
      const absolutePath = path.resolve(target);
      return createExternalLocation(vscode.Uri.file(absolutePath));
    }

    const normalized = path.normalize(target);
    const segments = normalized.split(/\\|\//).filter(Boolean);
    const absolute =
      segments.length > 0
        ? vscode.Uri.joinPath(workspaceRoot, ...segments)
        : workspaceRoot;
    return createWorkspaceLocation(absolute, workspaceRoot);
  }

  const normalized = path.normalize(target);
  const absoluteUri = vscode.Uri.file(normalized);
  const workspaceRoot = WorkspaceFS.getUri();
  if (workspaceRoot) {
    const relative = WorkspaceFS.relativePath(absoluteUri);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return createWorkspaceLocation(absoluteUri, workspaceRoot);
    }
  }

  return createExternalLocation(absoluteUri);
}
