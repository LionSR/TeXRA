// Standard library imports
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Third-party imports
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { loadSourceModule } from './loadSourceModule.ts';

// `rm` keeps its real implementation by default; tests arm one-shot failures
// with mockRejectedValueOnce to exercise the cleanup-retry path. The source
// module observes the same mock because loadSourceModule imports it through
// Vitest's module runner.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: vi.fn(original.rm) };
});

type DesktopDiffHostModule = typeof import('@desktop/main/desktopDiffHost');
type DiffHostOptions = Parameters<
  DesktopDiffHostModule['createDesktopDiffHost']
>[0];
type DiffHost = ReturnType<DesktopDiffHostModule['createDesktopDiffHost']>;

let createDesktopDiffHost: DesktopDiffHostModule['createDesktopDiffHost'];

// Every case needs the external-editor fallback observable, so the harness owns
// `openPath` and the paths it received.
function createHost(overrides: Partial<DiffHostOptions> = {}) {
  const openedPaths: string[] = [];
  const openPath = vi.fn(async (filePath: string) => {
    openedPaths.push(filePath);
  });
  const host = createDesktopDiffHost({ openPath, ...overrides });
  hosts.push(host);
  return {
    host,
    openPath,
    openedPaths,
  };
}

function expectOpenedPatchFile(openedPaths: readonly string[]): void {
  expect(openedPaths).toHaveLength(1);
  expect(path.extname(openedPaths[0])).toBe('.diff');
}

const tempDirs: string[] = [];
const hosts: DiffHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.dispose()));
  hosts.length = 0;
  await cleanupTempDirs(tempDirs);
});

type OpenDiffArgs = Parameters<DiffHost['openDiff']>;
type OpenDiffSources = [OpenDiffArgs[0], OpenDiffArgs[1]];

async function prepareDiffPair(
  names: [string, string] = ['a.tex', 'b.tex'],
  texts: [string, string] = ['a\n', 'b\n'],
): Promise<OpenDiffSources> {
  const tempDir = await makeTempDir('texra-diff-host-test-', tempDirs);
  const originalPath = path.join(tempDir, names[0]);
  const proposedPath = path.join(tempDir, names[1]);
  await Promise.all([
    writeFile(originalPath, texts[0], 'utf8'),
    writeFile(proposedPath, texts[1], 'utf8'),
  ]);
  return [{ filePath: originalPath }, { filePath: proposedPath }];
}

async function openDiffPair(
  host: DiffHost,
  title: string,
  names: [string, string] = ['a.tex', 'b.tex'],
  texts: [string, string] = ['a\n', 'b\n'],
): Promise<void> {
  const [original, proposed] = await prepareDiffPair(names, texts);
  await host.openDiff(original, proposed, title);
}

// Sorted so two snapshots compare equal when nothing was created or removed.
function listDiffTempDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith('texra-desktop-diff-'))
    .sort();
}

describe('createDesktopDiffHost', () => {
  beforeAll(async () => {
    ({ createDesktopDiffHost } = await loadSourceModule(
      '@desktop/main/desktopDiffHost',
    ));
  });

  it('falls back to a generated patch file when no renderer is wired', async () => {
    const { host, openedPaths } = createHost();

    await openDiffPair(
      host,
      'Compare',
      ['original.txt', 'proposed.txt'],
      ['hello\nold\n', 'hello\nnew\n'],
    );

    expectOpenedPatchFile(openedPaths);
    const patch = await readFile(openedPaths[0], 'utf8');
    expect(patch).toContain('-old');
    expect(patch).toContain('+new');
  });

  it('posts desktop:showDiff to the renderer when wired', async () => {
    const posted: unknown[] = [];
    // External fallback should not be invoked when postToRenderer is set.
    const { host, openPath } = createHost({
      postToRenderer: (message) => {
        posted.push(message);
        return true;
      },
    });

    await openDiffPair(
      host,
      'Compare doc.tex',
      ['doc.tex', 'doc.proposed.tex'],
      ['hello\nold\n', 'hello\nnew\n'],
    );

    expect(openPath).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      command: 'desktop:showDiff',
      title: 'Compare doc.tex',
      displayPath: 'Compare doc.tex',
      originalText: 'hello\nold\n',
      proposedText: 'hello\nnew\n',
      additions: 1,
      deletions: 1,
      language: 'latex',
    });
  });

  it('falls back to the external editor when postToRenderer returns false', async () => {
    // Simulates the renderer not being reachable — IPC bridge not yet
    // wired at startup or BrowserWindow already destroyed. Bot review
    // (#3815, Copilot + Cursor): the host previously silently dropped
    // the diff in this case.
    const { host, openedPaths } = createHost({ postToRenderer: () => false });

    await openDiffPair(host, 'Compare');

    expectOpenedPatchFile(openedPaths);
  });

  it('falls back to the external editor when postToRenderer throws', async () => {
    // Suppress the deliberate console.error from the host so the test
    // output stays clean.
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { host, openedPaths } = createHost({
      postToRenderer: () => {
        throw new Error('renderer destroyed');
      },
    });

    await openDiffPair(host, 'Compare');

    expectOpenedPatchFile(openedPaths);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('honors forceExternal even when postToRenderer is wired', async () => {
    const posted: unknown[] = [];
    const { host, openedPaths } = createHost({
      postToRenderer: (message) => {
        posted.push(message);
        return true;
      },
      forceExternal: true,
    });

    await openDiffPair(host, 'Compare', ['a.txt', 'b.txt']);

    expect(posted).toHaveLength(0);
    expectOpenedPatchFile(openedPaths);
  });

  it('removes external-editor patch directories when the host is disposed', async () => {
    const { host, openedPaths } = createHost();

    await openDiffPair(host, 'Compare');
    const diffPath = openedPaths[0];
    const diffDir = path.dirname(diffPath);

    expect(existsSync(diffPath)).toBe(true);
    expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);

    await host.dispose();

    expect(existsSync(diffDir)).toBe(false);
  });

  it('removes the patch directory immediately when the editor fails to open', async () => {
    const failure = new Error('editor unavailable');
    const { host, openPath } = createHost();
    openPath.mockRejectedValue(failure);

    // The original failure reaches the caller, not a cleanup artifact.
    await expect(openDiffPair(host, 'Compare')).rejects.toBe(failure);

    expect(openPath).toHaveBeenCalledTimes(1);
    const diffDir = path.dirname(openPath.mock.calls[0][0]);
    expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);
    expect(existsSync(diffDir)).toBe(false);
  });

  it('keeps a failed immediate cleanup recorded so dispose() retries it', async () => {
    // The one-shot rm rejection simulates an OS-level removal failure: the
    // directory must stay recorded (and the failure logged) so the dispose
    // at window close can retry it instead of leaking it untracked.
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { host, openPath } = createHost();
    openPath.mockRejectedValue(new Error('editor unavailable'));
    vi.mocked(rm).mockRejectedValueOnce(new Error('simulated removal failure'));

    await expect(openDiffPair(host, 'Compare')).rejects.toThrow(
      'editor unavailable',
    );

    const diffDir = path.dirname(openPath.mock.calls[0][0]);
    expect(existsSync(diffDir)).toBe(true);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    await host.dispose();

    expect(existsSync(diffDir)).toBe(false);
    consoleSpy.mockRestore();
  });

  it('removes a fallback directory created after disposal instead of recording it', async () => {
    // Destroyed-window-mid-fallback race: dispose() snapshots and clears the
    // record set while this openDiff is still awaiting its reads, so the temp
    // directory it creates afterwards must be removed immediately rather than
    // recorded, where nothing would ever remove it.
    const { host, openPath } = createHost();
    const [original, proposed] = await prepareDiffPair();
    const diffDirsBefore = listDiffTempDirs();

    const openPromise = host.openDiff(original, proposed, 'Compare');
    await host.dispose();

    await expect(openPromise).rejects.toThrow(
      'Desktop window closed before the diff could be opened.',
    );
    expect(openPath).not.toHaveBeenCalled();
    expect(listDiffTempDirs()).toEqual(diffDirsBefore);
  });
});
