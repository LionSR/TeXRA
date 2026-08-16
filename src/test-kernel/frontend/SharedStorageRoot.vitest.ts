// Node imports
import * as path from 'node:path';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mergeLegacyStorageBucket: vi.fn(),
  mergeLegacyWorkspaceStorageBucket: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('vscode', () => ({}));
vi.mock('@platform/defaults/legacyDataMigration', () => ({
  mergeLegacyStorageBucket: mocks.mergeLegacyStorageBucket,
  mergeLegacyWorkspaceStorageBucket: mocks.mergeLegacyWorkspaceStorageBucket,
}));
vi.mock('@logger/logUtils', () => ({
  createLog: (channel: string) => ({
    info: vi.fn(),
    warn: (message: string) => mocks.warn(channel, message),
  }),
}));

// Local imports - extension
import { migrateLegacyVscodeStorage } from '@frontend/vscode/sharedStorageRoot';

type MigrationContext = Parameters<typeof migrateLegacyVscodeStorage>[0];
type MigrationStorage = Parameters<typeof migrateLegacyVscodeStorage>[1];

function absolutePath(...segments: string[]): string {
  return path.join(path.sep, ...segments);
}

const context = {
  storageUri: { fsPath: absolutePath('legacy', 'workspace') },
  globalStorageUri: { fsPath: absolutePath('legacy', 'global') },
} as MigrationContext;

describe('VS Code shared-storage migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mergeLegacyStorageBucket.mockResolvedValue(undefined);
    mocks.mergeLegacyWorkspaceStorageBucket.mockResolvedValue(undefined);
  });

  it('still migrates global storage when workspace target resolution fails', async () => {
    const storage = {
      getStoragePath: () => {
        throw new Error('workspace unavailable');
      },
      getGlobalStoragePath: () => absolutePath('shared', 'global'),
    } as MigrationStorage;

    await expect(
      migrateLegacyVscodeStorage(context, storage),
    ).resolves.toBeUndefined();

    expect(mocks.mergeLegacyStorageBucket).toHaveBeenCalledOnce();
    expect(mocks.mergeLegacyStorageBucket).toHaveBeenCalledWith(
      absolutePath('legacy', 'global'),
      absolutePath('shared', 'global'),
      expect.objectContaining({
        label: 'vscode-global-storage',
        mergePerChild: ['custom_agents', 'ei_threads'],
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'extension',
      expect.stringContaining('vscode-workspace-storage migration failed'),
    );
  });

  it('keeps a successful workspace migration when global resolution fails', async () => {
    const storage = {
      getStoragePath: () => absolutePath('shared', 'workspace'),
      getGlobalStoragePath: () => {
        throw new Error('global unavailable');
      },
    } as MigrationStorage;

    await expect(
      migrateLegacyVscodeStorage(context, storage),
    ).resolves.toBeUndefined();

    expect(mocks.mergeLegacyWorkspaceStorageBucket).toHaveBeenCalledOnce();
    expect(mocks.mergeLegacyWorkspaceStorageBucket).toHaveBeenCalledWith(
      absolutePath('legacy', 'workspace'),
      absolutePath('shared', 'workspace'),
      expect.objectContaining({
        label: 'vscode-workspace-storage',
      }),
    );
    expect(mocks.mergeLegacyStorageBucket).toHaveBeenNthCalledWith(
      1,
      absolutePath('legacy', 'workspace', 'taskRuns'),
      absolutePath('shared', 'workspace', 'executions'),
      expect.objectContaining({
        label: 'vscode-workspace-storage/taskRuns',
        mergePerChild: 'all',
      }),
    );
    expect(mocks.mergeLegacyStorageBucket).toHaveBeenNthCalledWith(
      2,
      absolutePath('shared', 'workspace', 'taskRuns'),
      absolutePath('shared', 'workspace', 'executions'),
      expect.objectContaining({
        label: 'shared-workspace-storage/taskRuns',
        mergePerChild: 'all',
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'extension',
      expect.stringContaining('vscode-global-storage migration failed'),
    );
  });
});
