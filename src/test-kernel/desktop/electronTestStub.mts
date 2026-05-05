// Node imports
import { mkdtempSync } from 'node:fs';
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
let userDataPath: string | undefined;
let safeStorageBackend: SafeStorageBackend = DEFAULT_SAFE_STORAGE_BACKEND;
let safeStorageEncryptionAvailable = true;

function makeDefaultUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'texra-electron-test-'));
}

function getUserDataPath(): string {
  userDataPath ??= makeDefaultUserDataPath();
  return userDataPath;
}

export function configureElectronTestStub(
  options: ElectronTestStubOptions,
): void {
  userDataPath = options.userDataPath ?? userDataPath;
  safeStorageBackend = options.safeStorageBackend ?? safeStorageBackend;
  safeStorageEncryptionAvailable =
    options.safeStorageEncryptionAvailable ?? safeStorageEncryptionAvailable;
}

export function getElectronTestStubUserDataPath(): string | undefined {
  return userDataPath;
}

export function resetElectronTestStub(): void {
  userDataPath = undefined;
  safeStorageBackend = DEFAULT_SAFE_STORAGE_BACKEND;
  safeStorageEncryptionAvailable = true;
}

export const app = {
  getAppPath: () => repoPath(),
  getPath: (name: string) =>
    name === 'userData' ? getUserDataPath() : join(getUserDataPath(), name),
  getVersion: () => '0.0.0-test',
};

export const safeStorage = {
  decryptString: (value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, ''),
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  getSelectedStorageBackend: () => safeStorageBackend,
  isEncryptionAvailable: () => safeStorageEncryptionAvailable,
};
