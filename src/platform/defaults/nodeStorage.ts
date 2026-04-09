/**
 * Node.js storage path provider for CLI / Electron / tests.
 * Uses ~/.texra/ as the default storage location.
 */
import * as os from 'os';
import * as path from 'path';

import type { StorageProvider } from '../interfaces/storage';

export const nodeStorage: StorageProvider = {
  getStoragePath(): string {
    return path.join(os.homedir(), '.texra', 'workspace-storage');
  },

  getGlobalStoragePath(): string {
    return path.join(os.homedir(), '.texra', 'global-storage');
  },
};
