// Node imports
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.ts';

type SafeStorageBackend =
  'basic_text' | 'gnome_libsecret' | 'kwallet' | 'os_crypt';

type MessageBoxOptions = { message: string; type?: string };

interface ElectronTestStubOptions {
  safeStorageBackend?: SafeStorageBackend;
  safeStorageEncryptionAvailable?: boolean;
  userDataPath?: string;
}

const DEFAULT_SAFE_STORAGE_BACKEND = 'os_crypt';
let userDataPath: string | undefined;
let safeStorageBackend: SafeStorageBackend = DEFAULT_SAFE_STORAGE_BACKEND;
let safeStorageEncryptionAvailable = true;

function getUserDataPath(): string {
  userDataPath ??= mkdtempSync(join(tmpdir(), 'texra-electron-test-'));
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

export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
};

export const dialog = {
  showMessageBox: async (
    _windowOrOptions: unknown,
    _options?: MessageBoxOptions,
  ) => ({ response: 0, checkboxChecked: false }),
};

export const shell = {
  openExternal: async (_url: string) => undefined,
  openPath: async (_path: string) => '',
};
