// Standard library imports
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Third-party imports
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type DesktopDiffHostModule = typeof import('@desktop/main/desktopDiffHost');
type DiffHostOptions = Parameters<
  DesktopDiffHostModule['createDesktopDiffHost']
>[0];

let createDesktopDiffHost: DesktopDiffHostModule['createDesktopDiffHost'];

// Every case needs the external-editor fallback observable, so the harness owns
// `openPath` and the paths it received.
function createHost(overrides: Partial<DiffHostOptions> = {}) {
  const openedPaths: string[] = [];
  const openPath = vi.fn(async (filePath: string) => {
    openedPaths.push(filePath);
  });
  return {
    host: createDesktopDiffHost({ openPath, ...overrides }),
    openPath,
    openedPaths,
  };
}

function expectOpenedPatchFile(openedPaths: readonly string[]): void {
  expect(openedPaths).toHaveLength(1);
  expect(path.extname(openedPaths[0])).toBe('.diff');
}

async function writeDiffPair(
  originalName: string,
  proposedName: string,
  originalText = 'a\n',
  proposedText = 'b\n',
): Promise<{ originalPath: string; proposedPath: string }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
  const originalPath = path.join(tempDir, originalName);
  const proposedPath = path.join(tempDir, proposedName);
  await Promise.all([
    writeFile(originalPath, originalText, 'utf8'),
    writeFile(proposedPath, proposedText, 'utf8'),
  ]);
  return { originalPath, proposedPath };
}

describe('createDesktopDiffHost', () => {
  beforeAll(async () => {
    ({ createDesktopDiffHost } = (await import(
      moduleFileUrl(desktopSourcePath('main', 'desktopDiffHost.ts'))
    )) as DesktopDiffHostModule);
  });

  it('falls back to a generated patch file when no renderer is wired', async () => {
    const { originalPath, proposedPath } = await writeDiffPair(
      'original.txt',
      'proposed.txt',
      'hello\nold\n',
      'hello\nnew\n',
    );
    const { host, openedPaths } = createHost();

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expectOpenedPatchFile(openedPaths);
    await expect(readFile(openedPaths[0], 'utf8')).resolves.toContain('-old');
    await expect(readFile(openedPaths[0], 'utf8')).resolves.toContain('+new');
  });

  it('posts desktop:showDiff to the renderer when wired', async () => {
    const { originalPath, proposedPath } = await writeDiffPair(
      'doc.tex',
      'doc.proposed.tex',
      'hello\nold\n',
      'hello\nnew\n',
    );
    const posted: unknown[] = [];
    // External fallback should not be invoked when postToRenderer is set.
    const { host, openPath } = createHost({
      postToRenderer: (message) => {
        posted.push(message);
        return true;
      },
    });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare doc.tex',
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
      proposedPath,
      originalPath,
    });
  });

  it('falls back to the external editor when postToRenderer returns false', async () => {
    // Simulates the renderer not being reachable — IPC bridge not yet
    // wired at startup or BrowserWindow already destroyed. Bot review
    // (#3815, Copilot + Cursor): the host previously silently dropped
    // the diff in this case.
    const { originalPath, proposedPath } = await writeDiffPair(
      'a.tex',
      'b.tex',
    );
    const { host, openedPaths } = createHost({ postToRenderer: () => false });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expectOpenedPatchFile(openedPaths);
  });

  it('falls back to the external editor when postToRenderer throws', async () => {
    const { originalPath, proposedPath } = await writeDiffPair(
      'a.tex',
      'b.tex',
    );
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

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expectOpenedPatchFile(openedPaths);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('honors forceExternal even when postToRenderer is wired', async () => {
    const { originalPath, proposedPath } = await writeDiffPair(
      'a.txt',
      'b.txt',
    );
    const posted: unknown[] = [];
    const { host, openedPaths } = createHost({
      postToRenderer: (message) => {
        posted.push(message);
        return true;
      },
      forceExternal: true,
    });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expect(posted).toHaveLength(0);
    expectOpenedPatchFile(openedPaths);
  });
});
