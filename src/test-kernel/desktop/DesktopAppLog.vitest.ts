// Node imports
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import * as logger from '@logger/logUtils';

// Local imports - test support
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
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
  appendLogUtilsLine(line: string): void;
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
    resetElectronTestStub();
    vi.restoreAllMocks();
    logger.setOutputChannelFactory(null);
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
    const { root } = await writeDesktopLog(`${'🙂'.repeat(8)}tail`);
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
    const workspacePath = 'C:\\work\\project';
    await writeDesktopLog(
      `Opened ${workspacePath}\\paper.tex; queued ${workspacePath}, completed ${workspacePath} successfully; finished ${workspacePath}. retained ${workspacePath}-archive\\paper.tex and ${workspacePath}.archive\\paper.tex`,
    );
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath });

    expect(snapshot.text).toContain('Opened [path]\\paper.tex');
    expect(snapshot.text).toContain('queued [path],');
    expect(snapshot.text).toContain('completed [path] successfully');
    expect(snapshot.text).toContain('finished [path].');
    expect(snapshot.text).toContain(`${workspacePath}-archive\\paper.tex`);
    expect(snapshot.text).toContain(`${workspacePath}.archive\\paper.tex`);
  });

  it('redacts descendants of a separator-terminated workspace root', async () => {
    await writeDesktopLog('Opened C:\\Users\\alice\\paper.tex');
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath: 'C:\\' });

    expect(snapshot.text).toBe('Opened [path]Users\\alice\\paper.tex');
  });

  it('redacts a POSIX-root path without rewriting URLs or relative separators', async () => {
    await writeDesktopLog(
      'Opened /Users/alice/paper.tex; fetched https://example.com; read src/file.ts',
    );
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath: '/' });

    expect(snapshot.text).toBe(
      'Opened [path]Users/alice/paper.tex; fetched https://example.com; read src/file.ts',
    );
  });

  it('redacts a workspace nested under the home directory before home redaction', async () => {
    const workspacePath = join(homedir(), 'texra-project');
    await writeDesktopLog(`Opened ${workspacePath}/paper.tex`);
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath });

    expect(snapshot.text).toBe('Opened [path]/paper.tex');
  });

  it('writes logUtils lines through verbatim instead of re-stamping them via the console mirror', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    configureElectronTestStub({ userDataPath: join(root, 'userData') });
    const { installDesktopAppLog, appendLogUtilsLine, readDesktopLogSnapshot } =
      await loadDesktopAppLogModule();

    installDesktopAppLog();
    appendLogUtilsLine('ERROR [2026-09-09 00:00:00.000] [channel] boom');

    const snapshot = readDesktopLogSnapshot({});
    const lastLine = snapshot.text.trim().split('\n').at(-1);

    expect(lastLine).toBe('ERROR [2026-09-09 00:00:00.000] [channel] boom');
  });

  it('routes logUtils.createLog(...).error(...) through the wired sink at ERROR severity, not console.info', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    configureElectronTestStub({ userDataPath: join(root, 'userData') });
    const { installDesktopAppLog, appendLogUtilsLine, readDesktopLogSnapshot } =
      await loadDesktopAppLogModule();
    const consoleInfoSpy = vi.spyOn(console, 'info');

    installDesktopAppLog();
    // Same factory shape platform/index.ts wires in initializeElectronPlatform.
    logger.setOutputChannelFactory((name) => ({
      appendLine: (message) => appendLogUtilsLine(`[${name}] ${message}`),
    }));
    logger.createLog('channel').error('boom');

    const snapshot = readDesktopLogSnapshot({});
    const lastLine = snapshot.text.trim().split('\n').at(-1);

    expect(lastLine).toMatch(
      /^\[TeXRA\] ERROR \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[channel\] boom$/,
    );
    // The un-wired fallback sink writes through console.info; confirms this
    // path bypasses it (and therefore the level-blind console mirror).
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });
});
