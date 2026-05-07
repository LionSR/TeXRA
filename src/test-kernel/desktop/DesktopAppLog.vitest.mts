// Node imports
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import {
  configureElectronTestStub,
  resetElectronTestStub,
} from './electronTestStub.mjs';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopAppLogModule {
  installDesktopAppLog(): string | undefined;
  readDesktopLogSnapshot(options: {
    workspacePath?: string | undefined;
    maxBytes?: number | undefined;
  }): { path: string; text: string; truncated: boolean };
}

async function loadDesktopAppLogModule(): Promise<DesktopAppLogModule> {
  const cacheKey = randomUUID();
  return import(
    `${moduleFileUrl(desktopSourcePath('main', 'desktopAppLog.ts'))}?${cacheKey}`
  ) as Promise<DesktopAppLogModule>;
}

describe('desktop app log', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetElectronTestStub();
    vi.restoreAllMocks();
    const pathsToRemove = [...new Set(tempDirs.splice(0))];
    await Promise.all(
      pathsToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

  it('does not abort startup when the logs directory cannot be created', async () => {
    const root = await makeTempDir('texra-electron-log-');
    const userDataFile = join(root, 'userData-file');
    await writeFile(userDataFile, '');
    configureElectronTestStub({ userDataPath: userDataFile });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { installDesktopAppLog } = await loadDesktopAppLogModule();

    expect(() => installDesktopAppLog()).not.toThrow();
    expect(installDesktopAppLog()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'TeXRA desktop file logging is disabled.',
      expect.anything(),
    );
  });

  it('truncates viewer snapshots by bytes and redacts log paths', async () => {
    const root = await makeTempDir('texra-electron-log-');
    const userDataPath = join(root, 'userData');
    const logsPath = join(userDataPath, 'logs');
    const logPath = join(logsPath, 'texra-desktop.log');
    await mkdir(logsPath, { recursive: true });
    await writeFile(logPath, `${'🙂'.repeat(8)}tail`);
    configureElectronTestStub({ userDataPath });
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({
      workspacePath: root,
      maxBytes: 12,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toBe('🙂🙂tail');
    expect(Buffer.byteLength(snapshot.text)).toBe(12);
    expect(snapshot.path).toBe('[path]/userData/logs/texra-desktop.log');
  });
});
