// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mergeLegacyStorageBucket: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('vscode', () => ({}));
vi.mock('@platform/defaults/legacyDataMigration', () => ({
  mergeLegacyStorageBucket: mocks.mergeLegacyStorageBucket,
}));
vi.mock('@logger/logUtils', () => ({
  info: vi.fn(),
  warn: mocks.warn,
}));

// Local imports - extension
import { migrateLegacyVscodeStorage } from '@frontend/vscode/sharedStorageRoot';

type MigrationContext = Parameters<typeof migrateLegacyVscodeStorage>[0];
type MigrationStorage = Parameters<typeof migrateLegacyVscodeStorage>[1];

const context = {
  storageUri: { fsPath: '/legacy/workspace' },
  globalStorageUri: { fsPath: '/legacy/global' },
} as MigrationContext;

describe('VS Code shared-storage migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mergeLegacyStorageBucket.mockResolvedValue(undefined);
  });

  it('still migrates global storage when workspace target resolution fails', async () => {
    const storage = {
      getStoragePath: () => {
        throw new Error('workspace unavailable');
      },
      getGlobalStoragePath: () => '/shared/global',
    } as MigrationStorage;

    await expect(
      migrateLegacyVscodeStorage(context, storage),
    ).resolves.toBeUndefined();

    expect(mocks.mergeLegacyStorageBucket).toHaveBeenCalledTimes(1);
    expect(mocks.mergeLegacyStorageBucket).toHaveBeenCalledWith(
      '/legacy/global',
      '/shared/global',
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
      getStoragePath: () => '/shared/workspace',
      getGlobalStoragePath: () => {
        throw new Error('global unavailable');
      },
    } as MigrationStorage;

    await expect(
      migrateLegacyVscodeStorage(context, storage),
    ).resolves.toBeUndefined();

    expect(mocks.mergeLegacyStorageBucket).toHaveBeenCalledTimes(1);
    expect(mocks.mergeLegacyStorageBucket).toHaveBeenCalledWith(
      '/legacy/workspace',
      '/shared/workspace',
      expect.objectContaining({
        label: 'vscode-workspace-storage',
        mergePerChild: expect.arrayContaining([
          'executions',
          'memories',
          'streamLogs',
        ]),
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'extension',
      expect.stringContaining('vscode-global-storage migration failed'),
    );
  });
});
