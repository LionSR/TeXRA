// Standard library imports
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

describe('createDesktopDiffHost', () => {
  it('opens a generated patch file for compared files', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'original.txt');
    const proposedPath = path.join(tempDir, 'proposed.txt');
    await Promise.all([
      writeFile(originalPath, 'hello\nold\n', 'utf8'),
      writeFile(proposedPath, 'hello\nnew\n', 'utf8'),
    ]);
    const openedPaths: string[] = [];
    const { createDesktopDiffHost } = (await import(
      moduleFileUrl(desktopSourcePath('main', 'desktopDiffHost.ts'))
    )) as typeof import('../../../packages/desktop/src/main/desktopDiffHost');

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

  it('posts desktop:showDiff to the renderer when postToRenderer is wired', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'original.tex');
    const proposedPath = path.join(tempDir, 'proposed.tex');
    await Promise.all([
      writeFile(originalPath, 'Hello\nworld\n', 'utf8'),
      writeFile(proposedPath, 'Hello\nbrave new world\n', 'utf8'),
    ]);
    const openPath = vi.fn(async () => undefined);
    const postToRenderer = vi.fn();
    const { createDesktopDiffHost } = (await import(
      moduleFileUrl(desktopSourcePath('main', 'desktopDiffHost.ts'))
    )) as typeof import('../../../packages/desktop/src/main/desktopDiffHost');

    const host = createDesktopDiffHost({ openPath, postToRenderer });
    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    // Renderer path was preferred; external editor was not invoked.
    expect(openPath).not.toHaveBeenCalled();
    expect(postToRenderer).toHaveBeenCalledTimes(1);
    const message = postToRenderer.mock.calls[0]?.[0] as {
      command: string;
      diff: {
        title: string;
        originalPath: string;
        proposedPath: string;
        originalText: string;
        proposedText: string;
        language?: string;
      };
    };
    expect(message.command).toBe('desktop:showDiff');
    expect(message.diff.title).toBe('Compare');
    expect(message.diff.originalPath).toBe(originalPath);
    expect(message.diff.proposedPath).toBe(proposedPath);
    expect(message.diff.originalText).toBe('Hello\nworld\n');
    expect(message.diff.proposedText).toBe('Hello\nbrave new world\n');
    // .tex is mapped to the latex Monaco language id.
    expect(message.diff.language).toBe('latex');
  });

  it('falls back to external editor when postToRenderer throws', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-diff-host-test-'));
    const originalPath = path.join(tempDir, 'original.txt');
    const proposedPath = path.join(tempDir, 'proposed.txt');
    await Promise.all([
      writeFile(originalPath, 'a\n', 'utf8'),
      writeFile(proposedPath, 'b\n', 'utf8'),
    ]);
    const openedPaths: string[] = [];
    const openPath = vi.fn(async (filePath: string) => {
      openedPaths.push(filePath);
    });
    const postToRenderer = vi.fn(() => {
      throw new Error('renderer destroyed');
    });
    // Silence the host's console.error so the test output stays clean.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createDesktopDiffHost } = (await import(
      moduleFileUrl(desktopSourcePath('main', 'desktopDiffHost.ts'))
    )) as typeof import('../../../packages/desktop/src/main/desktopDiffHost');

    const host = createDesktopDiffHost({ openPath, postToRenderer });
    await host.openDiff(
      { filePath: originalPath },
      { filePath: proposedPath },
      'Compare',
    );

    expect(postToRenderer).toHaveBeenCalledTimes(1);
    expect(openedPaths).toHaveLength(1);
    expect(path.extname(openedPaths[0])).toBe('.diff');
    errorSpy.mockRestore();
  });
});
