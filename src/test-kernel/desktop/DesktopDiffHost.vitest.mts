// Standard library imports
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadDesktopDiffHost(): Promise<
  typeof import('../../../packages/desktop/src/main/desktopDiffHost')
> {
  return (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopDiffHost.ts'))
  )) as typeof import('../../../packages/desktop/src/main/desktopDiffHost');
}

describe('createDesktopDiffHost', () => {
  it('falls back to a generated patch file when no renderer is wired', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'original.txt');
    const proposedPath = path.join(tempDir, 'proposed.txt');
    await Promise.all([
      writeFile(originalPath, 'hello\nold\n', 'utf8'),
      writeFile(proposedPath, 'hello\nnew\n', 'utf8'),
    ]);
    const openedPaths: string[] = [];
    const { createDesktopDiffHost } = await loadDesktopDiffHost();

    const host = createDesktopDiffHost({
      openPath: vi.fn(async (filePath: string) => {
        openedPaths.push(filePath);
      }),
    });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expect(openedPaths).toHaveLength(1);
    expect(path.extname(openedPaths[0])).toBe('.diff');
    await expect(readFile(openedPaths[0], 'utf8')).resolves.toContain('-old');
    await expect(readFile(openedPaths[0], 'utf8')).resolves.toContain('+new');
  });

  it('posts desktop:showDiff to the renderer when wired', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'doc.tex');
    const proposedPath = path.join(tempDir, 'doc.proposed.tex');
    await Promise.all([
      writeFile(originalPath, 'hello\nold\n', 'utf8'),
      writeFile(proposedPath, 'hello\nnew\n', 'utf8'),
    ]);
    const posted: unknown[] = [];
    const openPath = vi.fn(async () => {
      // External fallback should not be invoked when postToRenderer is set.
    });

    const { createDesktopDiffHost } = await loadDesktopDiffHost();
    const host = createDesktopDiffHost({
      openPath,
      postToRenderer: (message) => posted.push(message),
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
      originalText: 'hello\nold\n',
      proposedText: 'hello\nnew\n',
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
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'a.tex');
    const proposedPath = path.join(tempDir, 'b.tex');
    await Promise.all([
      writeFile(originalPath, 'a\n', 'utf8'),
      writeFile(proposedPath, 'b\n', 'utf8'),
    ]);
    const openedPaths: string[] = [];
    const { createDesktopDiffHost } = await loadDesktopDiffHost();
    const host = createDesktopDiffHost({
      openPath: vi.fn(async (filePath: string) => {
        openedPaths.push(filePath);
      }),
      postToRenderer: () => false,
    });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expect(openedPaths).toHaveLength(1);
    expect(path.extname(openedPaths[0])).toBe('.diff');
  });

  it('falls back to the external editor when postToRenderer throws', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'a.tex');
    const proposedPath = path.join(tempDir, 'b.tex');
    await Promise.all([
      writeFile(originalPath, 'a\n', 'utf8'),
      writeFile(proposedPath, 'b\n', 'utf8'),
    ]);
    const openedPaths: string[] = [];
    const { createDesktopDiffHost } = await loadDesktopDiffHost();
    // Suppress the deliberate console.error from the host so the test
    // output stays clean.
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const host = createDesktopDiffHost({
      openPath: vi.fn(async (filePath: string) => {
        openedPaths.push(filePath);
      }),
      postToRenderer: () => {
        throw new Error('renderer destroyed');
      },
    });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expect(openedPaths).toHaveLength(1);
    expect(path.extname(openedPaths[0])).toBe('.diff');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('honors forceExternal even when postToRenderer is wired', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'a.txt');
    const proposedPath = path.join(tempDir, 'b.txt');
    await Promise.all([
      writeFile(originalPath, 'a\n', 'utf8'),
      writeFile(proposedPath, 'b\n', 'utf8'),
    ]);
    const posted: unknown[] = [];
    const openedPaths: string[] = [];
    const { createDesktopDiffHost } = await loadDesktopDiffHost();

    const host = createDesktopDiffHost({
      openPath: vi.fn(async (filePath: string) => {
        openedPaths.push(filePath);
      }),
      postToRenderer: (message) => posted.push(message),
      forceExternal: true,
    });

    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expect(posted).toHaveLength(0);
    expect(openedPaths).toHaveLength(1);
    expect(path.extname(openedPaths[0])).toBe('.diff');
  });
});
