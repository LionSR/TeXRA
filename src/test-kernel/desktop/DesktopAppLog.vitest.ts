// Node imports
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { setLogSink } from '@logger/logSink';

// Local imports - test support
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import {
  configureElectronTestStub,
  resetElectronTestStub,
} from './electronTestStub.ts';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

interface DesktopAppLogModule {
  readDesktopLogSnapshot(options: { workspacePath?: string | undefined }): {
    path: string;
    text: string;
    truncated: boolean;
  };
}

async function loadDesktopAppLogModule(): Promise<DesktopAppLogModule> {
  const cacheKey = randomUUID();
  return import(
    `${moduleFileUrl(desktopSourcePath('main', 'desktopAppLog.ts'))}?${cacheKey}`
  ) as Promise<DesktopAppLogModule>;
}

describe('desktop app log', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    setLogSink(null);
    resetElectronTestStub();
    vi.restoreAllMocks();
  });

  /** Writes a fresh desktop log and points the Electron stub at its dir. */
  async function writeDesktopLog(content: string): Promise<{ root: string }> {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    const userDataPath = join(root, 'userData');
    const logsPath = join(userDataPath, 'logs');
    const logPath = join(logsPath, 'texra-desktop.log');
    await mkdir(logsPath, { recursive: true });
    await writeFile(logPath, content);
    configureElectronTestStub({ userDataPath });
    return { root };
  }

  it.each([
    ['native separators', 'C:\\work\\project\\paper.tex'],
    [
      'backslashes doubled twice (util.format inspecting an object, then JSON)',
      JSON.stringify(
        JSON.stringify('C:\\work\\project\\paper.tex').slice(1, -1),
      ).slice(1, -1),
    ],
  ])('redacts a workspace path spelled with %s', async (_spelling, logged) => {
    await writeDesktopLog(`Opened ${logged}`);
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({
      workspacePath: 'C:\\work\\project',
    });

    expect(snapshot.text).toMatch(/^Opened \[path\][\\/]+paper\.tex$/);
    expect(snapshot.text).not.toContain('work');
  });
});
