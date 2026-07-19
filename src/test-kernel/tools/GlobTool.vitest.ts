import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { GlobTool } from '@tools/glob';

let workspacePath = '';

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failStatFor(fileName: string, error: Error): void {
  const fs = platform().fs;
  const stat = fs.stat.bind(fs);
  const targetPath = path.join(workspacePath, fileName);
  vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
    if (candidate === targetPath) throw error;
    return stat(candidate);
  });
}

describe('GlobTool match metadata', () => {
  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(tmpdir(), 'texra-glob-tool-'));
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
  });
  setupPlatform(() =>
    createFakePlatform({ workspacePath }, { fs: nodeFilesystem }),
  );
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('orders matches by modification time', async () => {
    const result = await new GlobTool().call({ pattern: '{old,new}.tex' });

    expect(result.status).toBe('executed');
    expect(result.output?.indexOf('new.tex')).toBeLessThan(
      result.output?.indexOf('old.tex') ?? -1,
    );
  });

  it('omits a match that disappears before metadata lookup', async () => {
    failStatFor('vanished.tex', fsError('ENOENT', 'match disappeared'));

    const result = await new GlobTool().call({ pattern: 'vanished.tex' });

    expect(result).toMatchObject({ status: 'executed' });
    expect(result.output).toContain('(no matches)');
  });

  it('omits a match whose parent is no longer a directory', async () => {
    failStatFor('blocked.tex', fsError('ENOTDIR', 'parent changed'));

    const result = await new GlobTool().call({ pattern: 'blocked.tex' });

    expect(result).toMatchObject({ status: 'executed' });
    expect(result.output).toContain('(no matches)');
  });

  it('surfaces operational stat failures through the tool boundary', async () => {
    failStatFor('unreadable.tex', fsError('EACCES', 'match is unreadable'));

    await expect(
      new GlobTool().call({ pattern: 'unreadable.tex' }),
    ).resolves.toMatchObject({
      status: 'error',
      error: 'match is unreadable',
    });
  });
});
