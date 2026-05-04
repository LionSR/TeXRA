// Node imports
import { join } from 'node:path';

export const app = {
  getAppPath: () => process.cwd(),
  getPath: (name: string) => join(process.cwd(), '.test-electron', name),
  getVersion: () => '0.0.0-test',
};

export const safeStorage = {
  decryptString: (value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, ''),
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  getSelectedStorageBackend: () => 'os_crypt',
  isEncryptionAvailable: () => true,
};
