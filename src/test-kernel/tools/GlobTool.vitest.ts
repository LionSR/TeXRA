import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
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
    await writeFile(path.join(workspacePath, '.gitignore'), 'dist/\n');
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

  it.each([
    {
      fileName: 'vanished.tex',
      error: fsError('ENOENT', 'match disappeared'),
    },
    {
      fileName: 'blocked.tex',
      error: fsError('ENOTDIR', 'parent changed'),
    },
  ])(
    'omits a match whose metadata lookup fails with $error.code',
    async ({ fileName, error }) => {
      await withGlobWorkspace(async (workspacePath) => {
        failStatFor(workspacePath, fileName, error);

        const result = await new GlobTool().call({ pattern: fileName });

        expect(result).toMatchObject({ status: 'executed' });
        expect(result.output).toContain('(no matches)');
      });
    },
  );

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

  it('does not pass unrestricted external paths to the workspace ignore matcher', async () => {
    await withGlobWorkspace(async () => {
      const externalPath = await mkdtemp(
        path.join(tmpdir(), 'texra-glob-external-'),
      );
      try {
        const externalDistPath = path.join(externalPath, 'dist');
        await mkdir(externalDistPath);
        await writeFile(
          path.join(externalDistPath, 'external.tex'),
          'external',
        );
        await platform().workspaceState.update(
          WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
          false,
        );

        const result = await new GlobTool().call({
          pattern: '**/*.tex',
          path: externalPath,
        });

        expect(result).toMatchObject({ status: 'executed' });
        expect(result.output).toContain('external.tex');
      } finally {
        await rm(externalPath, { recursive: true, force: true });
      }
    });
  });
});
