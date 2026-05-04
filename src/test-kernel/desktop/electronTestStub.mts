// Node imports
import { join } from 'node:path';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

const TEST_ELECTRON_STORAGE_ROOT = repoPath('.test-electron');

export const app = {
  getAppPath: () => repoPath(),
  getPath: (name: string) => join(TEST_ELECTRON_STORAGE_ROOT, name),
  getVersion: () => '0.0.0-test',
};

export const safeStorage = {
  decryptString: (value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, ''),
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  getSelectedStorageBackend: () => 'os_crypt',
  isEncryptionAvailable: () => true,
};
