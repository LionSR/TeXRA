// Node imports
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, relative } from 'node:path';

import * as logger from '@logger/logUtils';
import { isPathWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

// Local imports - platform
import type { StorageProvider } from '../interfaces';

const STORAGE_LAYOUT = {
  global: 'global-storage',
  workspace: 'workspace-storage',
  memory: 'memories',
  runs: 'executions',
  legacyRuns: 'taskRuns',
  original: 'original',
} as const;

export const MEMORY_STORAGE_DIR = STORAGE_LAYOUT.memory;
export const RUNS_STORAGE_DIR = STORAGE_LAYOUT.runs;
export const LEGACY_RUNS_STORAGE_DIR = STORAGE_LAYOUT.legacyRuns;

type WorkspacePathSource = string | undefined | (() => string | undefined);

function workspaceStorageHash(source: string, length: number): string {
  return createHash('sha256').update(source).digest('hex').slice(0, length);
}

function legacyWorkspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  return workspaceStorageHash(source, 16);
}

function sanitizeWorkspaceBasename(workspacePath: string): string {
  return sanitizePathSegment(basename(workspacePath), {
    invalidCharPattern: /[^A-Za-z0-9._-]/g,
    replacement: '-',
    collapseRepeats: true,
    trimReplacement: true,
    fallback: 'workspace',
  });
}

export function workspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  const stem =
    source === 'no-workspace'
      ? 'no-workspace'
      : sanitizeWorkspaceBasename(source);
  return `${stem}-${workspaceStorageHash(source, 8)}`;
}

export function resolveGlobalStoragePath(storageRoot: string): string {
  return join(storageRoot, STORAGE_LAYOUT.global);
}

export function resolveWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    STORAGE_LAYOUT.workspace,
    workspaceStorageId(workspacePath),
  );
}

export function resolveMemoryStoragePath(
  storagePath: string = MEMORY_STORAGE_DIR,
): string {
  const normalized = normalize(storagePath);
  const memoryRelative = relative(MEMORY_STORAGE_DIR, normalized);
  if (!isPathWithin(MEMORY_STORAGE_DIR, normalized)) {
    throw new Error(`Invalid memory path: ${storagePath}`);
  }
  return memoryRelative
    ? join(MEMORY_STORAGE_DIR, memoryRelative)
    : MEMORY_STORAGE_DIR;
}

export function resolveRunStoragePath(...segments: string[]): string {
  return segments.length
    ? join(RUNS_STORAGE_DIR, ...segments)
    : RUNS_STORAGE_DIR;
}

export function resolveLegacyRunStoragePath(...segments: string[]): string {
  return segments.length
    ? join(LEGACY_RUNS_STORAGE_DIR, ...segments)
    : LEGACY_RUNS_STORAGE_DIR;
}

export function resolveRunOriginalSnapshotPath(
  executionId: string,
  workspaceRelativePath: string,
): string {
  return resolveRunStoragePath(
    executionId,
    STORAGE_LAYOUT.original,
    workspaceRelativePath,
  );
}

export function resolveRunStorageRelativePath(
  absolutePath: string,
  runDirectory: string,
): string | undefined {
  const relativePath = relative(runDirectory, absolutePath).replaceAll(
    '\\',
    '/',
  );
  if (!isPathWithin(runDirectory, absolutePath)) return undefined;
  return relativePath || undefined;
}

export async function resolveExistingRunStoragePath(
  segments: readonly string[],
  exists: (storagePath: string) => Promise<boolean>,
): Promise<string | undefined> {
  const primary = resolveRunStoragePath(...segments);
  if (await exists(primary)) return primary;
  const legacy = resolveLegacyRunStoragePath(...segments);
  if (await exists(legacy)) return legacy;
  return undefined;
}

function resolveLegacyWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string {
  return join(
    storageRoot,
    STORAGE_LAYOUT.workspace,
    legacyWorkspaceStorageId(workspacePath),
  );
}

function writeWorkspaceSidecar(
  storagePath: string,
  workspacePath: string | undefined,
): void {
  const sidecarPath = join(storagePath, '_workspace.json');
  if (existsSync(sidecarPath)) return;

  writeFileSync(
    sidecarPath,
    `${JSON.stringify(
      {
        path: workspacePath?.trim() || null,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function migrateLegacyWorkspaceStorage(
  storageRoot: string,
  workspacePath: string | undefined,
): void {
  const currentPath = resolveWorkspaceStoragePath(storageRoot, workspacePath);
  const legacyPath = resolveLegacyWorkspaceStoragePath(
    storageRoot,
    workspacePath,
  );

  if (currentPath === legacyPath) return;
  if (!existsSync(legacyPath) || existsSync(currentPath)) return;
  try {
    renameSync(legacyPath, currentPath);
  } catch (error) {
    logger.warn(
      'WorkspaceStorage',
      `Could not migrate legacy workspace storage; continuing with the current storage directory. Cause: ${toErrorMessage(error)}`,
    );
  }
}

export class WorkspaceStorageProvider implements StorageProvider {
  private readonly getWorkspacePath: () => string | undefined;

  constructor(
    private readonly storageRoot: string,
    workspacePath: WorkspacePathSource,
  ) {
    this.getWorkspacePath =
      typeof workspacePath === 'function' ? workspacePath : () => workspacePath;
  }

  getStoragePath(): string {
    const workspacePath = this.getWorkspacePath();
    migrateLegacyWorkspaceStorage(this.storageRoot, workspacePath);
    const storagePath = resolveWorkspaceStoragePath(
      this.storageRoot,
      workspacePath,
    );
    mkdirSync(storagePath, { recursive: true });
    writeWorkspaceSidecar(storagePath, workspacePath);
    return storagePath;
  }

  getGlobalStoragePath(): string {
    const storagePath = resolveGlobalStoragePath(this.storageRoot);
    mkdirSync(storagePath, { recursive: true });
    return storagePath;
  }
}
