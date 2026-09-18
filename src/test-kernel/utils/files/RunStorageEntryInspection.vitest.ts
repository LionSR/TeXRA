// Node imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceRoots } from '@platform/workspaceRoots';

// Local imports
import { FileType, type FileStat } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { errnoError } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import {
  inspectRunStorageEntryUnder,
  runStorageLocationUnder,
} from '@utils/files/runStorageFs';
import { RunFileService } from '@utils/files/runStorage';

const runId = 'abcdef123456' as RunId;
const storageRoot = path.resolve(path.sep, 'storage');
const workspaceRoot = path.resolve(path.sep, 'workspace');
const originalStat = AbsoluteFS.stat;

setupPlatform({ storagePath: storageRoot, workspacePath: workspaceRoot });

function storagePath(...segments: string[]): string {
  return path.join(storageRoot, ...segments);
}

/** The absolute path the rooted helper stats for a run-relative entry. */
function primaryEntry(...segments: string[]): string {
  return storagePath('executions', runId, ...segments);
}

function fileStat(type: number): FileStat {
  return { type, ctime: 0, mtime: 0, size: 1 };
}

function missing(target: string): Error {
  return errnoError('ENOENT', `Missing: ${target}`);
}

describe('inspectRunStorageEntryUnder', () => {
  afterEach(() => {
    AbsoluteFS.stat = originalStat;
  });

  it('returns a canonical location for a regular primary-layout file', async () => {
    AbsoluteFS.stat = async (target: string) => {
      if (target === primaryEntry('r1', 'draft.tex')) {
        return fileStat(FileType.File);
      }
      if (target === primaryEntry() || target === primaryEntry('r1')) {
        return fileStat(FileType.Directory);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, 'r1\\draft.tex'),
    ).resolves.toEqual({
      kind: 'file',
      location: {
        kind: 'runStorage',
        absolutePath: storagePath('executions', runId, 'r1', 'draft.tex'),
        relativePath: 'r1/draft.tex',
        runId,
      },
    });
  });

  it.each([
    { type: FileType.SymbolicLink | FileType.File, kind: 'symlink' },
    { type: FileType.Directory, kind: 'directory' },
    { type: FileType.Unknown, kind: 'unsupported' },
  ] as const)(
    'classifies a non-bindable entry as $kind',
    async ({ type, kind }) => {
      AbsoluteFS.stat = async () => fileStat(type);

      await expect(
        inspectRunStorageEntryUnder(storageRoot, runId, 'result.tex'),
      ).resolves.toMatchObject({ kind });
    },
  );

  it('distinguishes missing entries from invalid paths', async () => {
    AbsoluteFS.stat = async (target: string) => {
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, 'missing.tex'),
    ).resolves.toEqual({ kind: 'missing' });
    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, '../outside.tex'),
    ).resolves.toMatchObject({ kind: 'invalid' });
    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, '/outside.tex'),
    ).resolves.toMatchObject({ kind: 'invalid' });
  });

  it('rejects a regular file reached through an ancestor symlink', async () => {
    AbsoluteFS.stat = async (target: string) => {
      if (target.endsWith(path.join('link', 'result.tex'))) {
        return fileStat(FileType.File);
      }
      if (target === primaryEntry()) {
        return fileStat(FileType.Directory);
      }
      if (target === primaryEntry('r1')) {
        return fileStat(FileType.Directory);
      }
      if (target === primaryEntry('r1', 'link')) {
        return fileStat(FileType.SymbolicLink | FileType.Directory);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, 'r1/link/result.tex'),
    ).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: storagePath('executions', runId, 'r1', 'link'),
    });
  });

  it('rejects a dangling ancestor symlink before treating the leaf as missing', async () => {
    const inspected: string[] = [];
    AbsoluteFS.stat = async (target: string) => {
      inspected.push(target);
      if (target === primaryEntry()) {
        return fileStat(FileType.Directory);
      }
      if (target === primaryEntry('dangling')) {
        return fileStat(FileType.SymbolicLink | FileType.Unknown);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, 'dangling/result.tex'),
    ).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: storagePath('executions', runId, 'dangling'),
    });
    expect(inspected).not.toContain(primaryEntry('dangling', 'result.tex'));
  });

  it('does not turn storage permission failures into a missing entry', async () => {
    AbsoluteFS.stat = async () => {
      throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    };

    await expect(
      inspectRunStorageEntryUnder(storageRoot, runId, 'result.tex'),
    ).rejects.toThrow('Denied');
  });

  it('recovers run identity from absolute run-storage paths', () => {
    expect(
      runStorageLocationUnder(
        storageRoot,
        storagePath('executions', runId, 'r2', 'result.tex'),
      ),
    ).toMatchObject({
      kind: 'runStorage',
      runId,
      relativePath: 'r2/result.tex',
    });
    expect(
      runStorageLocationUnder(
        storageRoot,
        path.join(workspaceRoot, 'result.tex'),
      ),
    ).toBeUndefined();
  });

  it('preserves source provenance instead of treating workspace inputs as outputs', () => {
    const fileService = new RunFileService(runId, workspaceRoots());

    expect(fileService.locateSource('draft.tex')).toEqual({
      kind: 'workspace',
      absolutePath: path.join(workspaceRoot, 'draft.tex'),
      relativePath: 'draft.tex',
    });
    expect(
      fileService.locateSource(
        storagePath('executions', runId, 'r1', 'draft.tex'),
      ),
    ).toMatchObject({
      kind: 'runStorage',
      runId,
      relativePath: 'r1/draft.tex',
    });
  });
});
