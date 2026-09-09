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
import * as rootsAccess from '@platform/workspaceRoots';
import type { WorkspaceRoots } from '@platform/workspaceRoots';

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
  appendLogUtilsChannelLine(name: string, message: string): void;
  appendLogUtilsContinuationLine(name: string, message: string): void;
}

async function loadDesktopAppLogModule(): Promise<DesktopAppLogModule> {
  const cacheKey = randomUUID();
  return import(
    `${moduleFileUrl(desktopSourcePath('main', 'desktopAppLog.ts'))}?${cacheKey}`
  ) as Promise<DesktopAppLogModule>;
}

// A successful installDesktopAppLog() replaces these five console methods
// with wrappers (installConsoleMirror), directly on the process-global
// `console` — not via vi.spyOn, so vi.restoreAllMocks() below doesn't undo
// it. Left alone, a wrapper would outlive its test and stack another layer
// on the next test that installs the mirror.
const ORIGINAL_CONSOLE_METHODS = {
  debug: console.debug,
  error: console.error,
  info: console.info,
  log: console.log,
  warn: console.warn,
};

describe('desktop app log', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    resetElectronTestStub();
    vi.restoreAllMocks();
    logger.setOutputChannelFactory(null);
    Object.assign(console, ORIGINAL_CONSOLE_METHODS);
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

  it("routes logUtils.createLog(...).error(...) through the wired sink at ERROR severity, in the desktop log parser's own line shape", async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    configureElectronTestStub({ userDataPath: join(root, 'userData') });
    const {
      installDesktopAppLog,
      appendLogUtilsChannelLine,
      appendLogUtilsContinuationLine,
      readDesktopLogSnapshot,
    } = await loadDesktopAppLogModule();
    const consoleInfoSpy = vi.spyOn(console, 'info');

    installDesktopAppLog();
    // Same factory shape platform/index.ts wires in initializeElectronPlatform.
    logger.setOutputChannelFactory((name) => ({
      appendLine: (message) => appendLogUtilsChannelLine(name, message),
      appendContinuationLine: (message) =>
        appendLogUtilsContinuationLine(name, message),
    }));
    logger.createLog('channel').error('boom');

    const snapshot = readDesktopLogSnapshot({});
    const lastLine = snapshot.text.trim().split('\n').at(-1) ?? '';

    // Same `<ISO timestamp> [<level>] <message>` shape
    // parseDesktopLogEntries (renderer/logsPane.ts) requires to recognize a
    // new entry, so the real level survives into the Logs tab instead of
    // folding into whichever entry happened to precede it.
    const match =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(?<level>debug|error|info|log|warn)\] (?<message>.*)$/u.exec(
        lastLine,
      );
    expect(match?.groups?.level).toBe('error');
    expect(match?.groups?.message).toMatch(
      /^\[TeXRA\] ERROR \[.+\] \[channel\] boom$/,
    );
    // The un-wired fallback sink writes through console.info; confirms this
    // path bypasses it (and therefore the level-blind console mirror).
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  it('falls back to console when the desktop log file is unavailable', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    const userDataFile = join(root, 'userData-file');
    await writeFile(userDataFile, '');
    configureElectronTestStub({ userDataPath: userDataFile });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { installDesktopAppLog, appendLogUtilsChannelLine } =
      await loadDesktopAppLogModule();

    installDesktopAppLog();
    appendLogUtilsChannelLine(
      'TeXRA',
      'ERROR [2026-09-09 00:00:00.000] [channel] boom',
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[TeXRA] ERROR [2026-09-09 00:00:00.000] [channel] boom',
    );
  });

  it('routes a debug-data payload to raw continuation text via writeLine, not its own entry, even when the payload text itself looks like a header', async () => {
    const root = await makeTempDir('texra-electron-log-', tempDirs);
    configureElectronTestStub({ userDataPath: join(root, 'userData') });
    const {
      installDesktopAppLog,
      appendLogUtilsChannelLine,
      appendLogUtilsContinuationLine,
      readDesktopLogSnapshot,
    } = await loadDesktopAppLogModule();
    // texra.logger.debugMode gates writeLine's data companion line.
    vi.spyOn(rootsAccess, 'tryWorkspaceRoots').mockReturnValue({
      config: { get: () => true },
    } as unknown as WorkspaceRoots);

    installDesktopAppLog();
    // Same factory shape platform/index.ts wires in initializeElectronPlatform.
    logger.setOutputChannelFactory((name) => ({
      appendLine: (message) => appendLogUtilsChannelLine(name, message),
      appendContinuationLine: (message) =>
        appendLogUtilsContinuationLine(name, message),
    }));
    // A payload that itself fully matches the real header shape (e.g.
    // compiler output containing a bracketed timestamp), which text-sniffing
    // could never safely rule out. writeLine routes it through the sink's
    // dedicated appendContinuationLine, not appendLine, so there's nothing to
    // sniff: it's always raw regardless of content.
    logger.createLog('channel').error('boom', {
      data: 'ERROR [2026-09-09 00:00:01.000] compiler failed',
    });

    const snapshot = readDesktopLogSnapshot({});
    const lines = snapshot.text.trim().split('\n');
    const [headerLine, continuationLine] = lines.slice(-2);

    expect(headerLine).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[error\] \[TeXRA\] ERROR \[.+\] \[channel\] boom$/,
    );
    expect(continuationLine).toBe(
      '[TeXRA] ERROR [2026-09-09 00:00:01.000] compiler failed',
    );
    // No <ISO timestamp> [<level>] header on the continuation line:
    // parseDesktopLogEntries (renderer/logsPane.ts) attaches it to the
    // header entry above instead of starting a new one.
    expect(continuationLine).not.toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});
