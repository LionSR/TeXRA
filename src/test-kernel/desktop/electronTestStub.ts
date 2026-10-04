// Node imports
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.ts';

type MessageBoxOptions = { message: string; type?: string };

interface ElectronTestStubOptions {
  userDataPath?: string;
}

let userDataPath: string | undefined;

function getUserDataPath(): string {
  userDataPath ??= mkdtempSync(join(tmpdir(), 'texra-electron-test-'));
  return userDataPath;
}

export function configureElectronTestStub(
  options: ElectronTestStubOptions,
): void {
  userDataPath = options.userDataPath ?? userDataPath;
}

export function resetElectronTestStub(): void {
  userDataPath = undefined;
}

export const app = {
  getAppPath: () => repoPath(),
  getPath: (name: string) =>
    name === 'userData' ? getUserDataPath() : join(getUserDataPath(), name),
  getVersion: () => '0.0.0-test',
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
