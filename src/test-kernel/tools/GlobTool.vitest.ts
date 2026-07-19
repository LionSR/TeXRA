// Node imports
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - platform
import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';

// Local imports - test support
import { installPlatform } from '@test/support/setupPlatform';

// Local imports - tools
import { GlobTool } from '@tools/glob';

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failStatFor(
  workspacePath: string,
  fileName: string,
  error: Error,
): void {
  const fs = platform().fs;
  const stat = fs.stat.bind(fs);
  const targetPath = path.join(workspacePath, fileName);
  vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
    if (candidate === targetPath) throw error;
    return stat(candidate);
  });
}

async function withGlobWorkspace(
  run: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'texra-glob-tool-'));
  await installPlatform({ workspacePath }, { fs: nodeFilesystem });
  try {
    await Promise.all(
      [
        'new.tex',
        'old.tex',
        'vanished.tex',
        'blocked.tex',
        'unreadable.tex',
      ].map((name) => writeFile(path.join(workspacePath, name), name)),
    );
    await utimes(path.join(workspacePath, 'old.tex'), 1, 1);
    await utimes(path.join(workspacePath, 'new.tex'), 2, 2);
    await run(workspacePath);
  } finally {
    vi.restoreAllMocks();
    await installPlatform();
    await rm(workspacePath, { recursive: true, force: true });
  }
}

describe('GlobTool match metadata', () => {
  it('orders matches by modification time', async () => {
    await withGlobWorkspace(async () => {
      const result = await new GlobTool().call({ pattern: '{old,new}.tex' });

      expect(result.status).toBe('executed');
      expect(result.output).toContain('new.tex');
      expect(result.output).toContain('old.tex');
      const output = result.output ?? '';
      expect(output.indexOf('new.tex')).toBeLessThan(output.indexOf('old.tex'));
    });
  });

  it('omits a match that disappears before metadata lookup', async () => {
    await withGlobWorkspace(async (workspacePath) => {
      failStatFor(
        workspacePath,
        'vanished.tex',
        fsError('ENOENT', 'match disappeared'),
      );

      const result = await new GlobTool().call({ pattern: 'vanished.tex' });

      expect(result).toMatchObject({ status: 'executed' });
      expect(result.output).toContain('(no matches)');
    });
  });

  it('omits a match whose parent is no longer a directory', async () => {
    await withGlobWorkspace(async (workspacePath) => {
      failStatFor(
        workspacePath,
        'blocked.tex',
        fsError('ENOTDIR', 'parent changed'),
      );

      const result = await new GlobTool().call({ pattern: 'blocked.tex' });

      expect(result).toMatchObject({ status: 'executed' });
      expect(result.output).toContain('(no matches)');
    });
  });

  it('surfaces operational stat failures through the tool boundary', async () => {
    await withGlobWorkspace(async (workspacePath) => {
      failStatFor(
        workspacePath,
        'unreadable.tex',
        fsError('EACCES', 'match is unreadable'),
      );

      await expect(
        new GlobTool().call({ pattern: 'unreadable.tex' }),
      ).resolves.toMatchObject({
        status: 'error',
        error: 'match is unreadable',
      });
    });
  });
});
