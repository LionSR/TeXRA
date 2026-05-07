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
});
