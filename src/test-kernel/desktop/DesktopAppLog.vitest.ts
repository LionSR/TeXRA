// Node imports
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import {
  configureElectronTestStub,
  resetElectronTestStub,
} from './electronTestStub.ts';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

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
    await cleanupTempDirs(tempDirs);
  });

  it('does not abort startup when the logs directory cannot be created', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
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
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    const userDataPath = join(root, 'userData');
    const logsPath = join(userDataPath, 'logs');
    const logPath = join(logsPath, 'texra-desktop.log');
    await mkdir(logsPath, { recursive: true });
    await writeFile(logPath, `${'🙂'.repeat(8)}tail`);
    configureElectronTestStub({ userDataPath });
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({
      workspacePath: root.replaceAll('/', '\\'),
      maxBytes: 12,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toBe('🙂🙂tail');
    expect(Buffer.byteLength(snapshot.text)).toBe(12);
    expect(snapshot.path).toBe('[path]/userData/logs/texra-desktop.log');
  });

  it('redacts native workspace paths in log text without redacting adjacent prefixes', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    const userDataPath = join(root, 'userData');
    const logsPath = join(userDataPath, 'logs');
    const logPath = join(logsPath, 'texra-desktop.log');
    const workspacePath = 'C:\\work\\project';
    await mkdir(logsPath, { recursive: true });
    await writeFile(
      logPath,
      `Opened ${workspacePath}\\paper.tex; queued ${workspacePath}, retained ${workspacePath}-archive\\paper.tex and ${workspacePath}.archive\\paper.tex`,
    );
    configureElectronTestStub({ userDataPath });
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath });

    expect(snapshot.text).toContain('Opened [path]\\paper.tex');
    expect(snapshot.text).toContain('queued [path],');
    expect(snapshot.text).toContain(`${workspacePath}-archive\\paper.tex`);
    expect(snapshot.text).toContain(`${workspacePath}.archive\\paper.tex`);
  });

  it('redacts a workspace nested under the home directory before home redaction', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    const userDataPath = join(root, 'userData');
    const logsPath = join(userDataPath, 'logs');
    const logPath = join(logsPath, 'texra-desktop.log');
    const workspacePath = join(homedir(), 'texra-project');
    await mkdir(logsPath, { recursive: true });
    await writeFile(logPath, `Opened ${workspacePath}/paper.tex`);
    configureElectronTestStub({ userDataPath });
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath });

    expect(snapshot.text).toBe('Opened [path]/paper.tex');
  });

  it('prefers home redaction when the workspace is its ancestor', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    const userDataPath = join(root, 'userData');
    const logsPath = join(userDataPath, 'logs');
    const logPath = join(logsPath, 'texra-desktop.log');
    const workspacePath = dirname(homedir());
    await mkdir(logsPath, { recursive: true });
    await writeFile(logPath, `Opened ${homedir()}/paper.tex`);
    configureElectronTestStub({ userDataPath });
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath });

    expect(snapshot.text).toBe('Opened [path]/paper.tex');
  });
});
