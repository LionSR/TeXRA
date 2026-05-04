// Node imports
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

type SafeStorageBackend =
  | 'basic_text'
  | 'gnome_libsecret'
  | 'kwallet'
  | 'os_crypt';

interface ElectronTestStubOptions {
  safeStorageBackend?: SafeStorageBackend;
  safeStorageEncryptionAvailable?: boolean;
  userDataPath?: string;
}

const DEFAULT_SAFE_STORAGE_BACKEND = 'os_crypt';
let resetCounter = 0;
let userDataPath = makeDefaultUserDataPath();
let safeStorageBackend: SafeStorageBackend = DEFAULT_SAFE_STORAGE_BACKEND;
let safeStorageEncryptionAvailable = true;

function makeDefaultUserDataPath(): string {
  resetCounter += 1;
  return join(tmpdir(), `texra-electron-test-${process.pid}-${resetCounter}`);
}

export function configureElectronTestStub(
  options: ElectronTestStubOptions,
): void {
  userDataPath = options.userDataPath ?? userDataPath;
  safeStorageBackend =
    options.safeStorageBackend ?? DEFAULT_SAFE_STORAGE_BACKEND;
  safeStorageEncryptionAvailable =
    options.safeStorageEncryptionAvailable ?? true;
}

export function resetElectronTestStub(): void {
  userDataPath = makeDefaultUserDataPath();
  safeStorageBackend = DEFAULT_SAFE_STORAGE_BACKEND;
  safeStorageEncryptionAvailable = true;
}

export const app = {
  getAppPath: () => repoPath(),
  getPath: (name: string) =>
    name === 'userData' ? userDataPath : join(userDataPath, name),
  getVersion: () => '0.0.0-test',
};

export const safeStorage = {
  decryptString: (value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, ''),
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  getSelectedStorageBackend: () => safeStorageBackend,
  isEncryptionAvailable: () => safeStorageEncryptionAvailable,
};
