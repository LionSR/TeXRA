// Node imports
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
    // Derived account name: a real home of C:\Users\<name> must not
    // redact this path before the separator-terminated workspace prefix.
    const account = `texra-redact-${basename(homedir())}`;
    await writeDesktopLog(`Opened C:\\Users\\${account}\\paper.tex`);
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath: 'C:\\' });

    expect(snapshot.text).toBe(`Opened [path]Users\\${account}\\paper.tex`);
  });

  it('redacts a POSIX-root path without rewriting URLs or relative separators', async () => {
    // Derived non-home path: a real home of /Users/<name> must not rewrite
    // this first and double-redact through the '/' branch.
    const nonHomePath = `/Users/${basename(homedir())}-other/paper.tex`;
    await writeDesktopLog(
      `Opened ${nonHomePath}; fetched https://example.com; read src/file.ts`,
    );
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath: '/' });

    expect(snapshot.text).toBe(
      `Opened [path]${nonHomePath.slice(1)}; fetched https://example.com; read src/file.ts`,
    );
  });

  it('redacts a workspace nested under the home directory before home redaction', async () => {
    const workspacePath = join(homedir(), 'texra-project');
    await writeDesktopLog(`Opened ${workspacePath}/paper.tex`);
    const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

    const snapshot = readDesktopLogSnapshot({ workspacePath });

    expect(snapshot.text).toBe('Opened [path]/paper.tex');
  });

  // Guard tests for the redactPathPrefixes contract (issue #10613). The
  // function stays module-private, so these exercise it through
  // readDesktopLogSnapshot, its only production call path: log text is
  // scrubbed with (workspacePath, homedir()) and then redactSecrets.
  describe('path prefix redaction', () => {
    it('redacts the longest nested prefix first so workspace contents stay hidden', async () => {
      const workspacePath = join(homedir(), 'texra-project');
      await writeDesktopLog(
        `Opened ${workspacePath}/paper.tex; also ${homedir()}/.config/texra/settings.json`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath });

      // Shortest-first would leak the project directory name as
      // '[path]/texra-project/paper.tex'.
      expect(snapshot.text).toBe(
        'Opened [path]/paper.tex; also [path]/.config/texra/settings.json',
      );
      expect(snapshot.text).not.toContain('texra-project');
    });

    it('redacts home paths before a shorter workspace prefix that contains them', async () => {
      const home = homedir();
      const root = dirname(home);
      const homeFile = join(home, 'a.txt');
      // The sibling extends basename(home), so the '-' follower defeats a
      // home-prefix boundary match and it can never equal the real home.
      const siblingFile = join(root, `${basename(home)}-sibling`, 'b.txt');
      await writeDesktopLog(`home ${homeFile}; other ${siblingFile}`);
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath: root });

      // home is always nested under dirname(home), so shortest-first ordering
      // leaks the account name as '[path]/<user>/a.txt' on every POSIX host.
      expect(snapshot.text).toBe(
        `home [path]${homeFile.slice(home.length)}; other [path]${siblingFile.slice(root.length)}`,
      );
    });

    it('treats regex metacharacters in a Windows workspace path literally', async () => {
      const workspacePath = 'C:\\work\\proj.ec';
      await writeDesktopLog(
        `dir ${workspacePath}\\a.tex and C:\\work\\projXec\\b.tex`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath });

      // Pins escapeRegExp both ways: unescaped, '\w' becomes a character
      // class that cannot match the literal backslash (the real prefix stops
      // redacting), and a bare '.' would also match the sibling's 'X'.
      expect(snapshot.text).toBe(
        'dir [path]\\a.tex and C:\\work\\projXec\\b.tex',
      );
    });

    it('redacts Windows paths at end of string and before mixed separators', async () => {
      const workspacePath = 'C:\\work\\project';
      await writeDesktopLog(
        `copy ${workspacePath}/src/main.tex; cd ${workspacePath}`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath });

      expect(snapshot.text).toBe('copy [path]/src/main.tex; cd [path]');
    });

    it('redacts descendants of a trailing-backslash Windows prefix without requiring a boundary', async () => {
      const workspacePath = 'D:\\build\\out\\';
      await writeDesktopLog(
        `wrote ${workspacePath}app.log; list ${workspacePath}`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath });

      // A boundary lookahead after the trailing separator would reject the
      // 'app.log' follower and leave the prefix visible.
      expect(snapshot.text).toBe('wrote [path]app.log; list [path]');
    });

    it('redacts repeated descendants of a trailing-slash POSIX prefix only', async () => {
      // Derived from basename(home) so neither path can equal or contain the
      // real home directory on any host.
      const account = `texra-redact-${basename(homedir())}`;
      const workspacePath = `/Users/${account}/`;
      await writeDesktopLog(
        `a ${workspacePath}docs/one.tex; b ${workspacePath}drafts/two.tex; keep /Users/${account}-other/c.tex`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath });

      expect(snapshot.text).toBe(
        `a [path]docs/one.tex; b [path]drafts/two.tex; keep /Users/${account}-other/c.tex`,
      );
    });

    it('redacts a POSIX-root workspace at string start and after quotes, preserving drive and URL separators', async () => {
      // Extends basename(home) with '-other', so the real home prefix never
      // boundary-matches it (a '/Users/alice' home would otherwise rewrite it
      // first and the '/' branch would double-redact the remainder).
      const nonHomePath = `/Users/${basename(homedir())}-other/x.tex`;
      await writeDesktopLog(
        `${nonHomePath}; ("C:/work/project"); fetch https://example.com/a; log "/etc/hosts"`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath: '/' });

      expect(snapshot.text).toBe(
        `[path]${nonHomePath.slice(1)}; ("C:/work/project"); fetch https://example.com/a; log "[path]etc/hosts"`,
      );
    });

    it('still redacts secrets after scrubbing path prefixes', async () => {
      const workspacePath = 'C:\\work\\project';
      await writeDesktopLog(
        `OPENAI_API_KEY=sk-1234567890abcdef saved to ${workspacePath}\\config.env`,
      );
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({ workspacePath });

      expect(snapshot.text).toBe(
        'OPENAI_API_KEY=[redacted] saved to [path]\\config.env',
      );
    });

    it('scrubs the home directory when no workspace path is provided', async () => {
      await writeDesktopLog(`config ${homedir()}/.config/texra/app.json`);
      const { readDesktopLogSnapshot } = await loadDesktopAppLogModule();

      const snapshot = readDesktopLogSnapshot({});

      expect(snapshot.text).toBe('config [path]/.config/texra/app.json');
    });
  });
});
