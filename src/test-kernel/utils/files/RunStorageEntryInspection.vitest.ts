// Node imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { FileType, type FileStat } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { errnoError } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';
import {
  inspectRunStorageEntry,
  runStorageLocationFromAnyAbsolutePath,
} from '@utils/files/runStorageFs';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

const runId = 'abcdef123456' as RunId;
const storageRoot = path.resolve(path.sep, 'storage');
const workspaceRoot = path.resolve(path.sep, 'workspace');
const originalStat = StorageFS.stat;
const originalFullPath = StorageFS.fullPath;

setupPlatform({ storagePath: storageRoot, workspacePath: workspaceRoot });

function primaryEntry(...segments: string[]): string {
  return path.posix.join('executions', runId, ...segments);
}

function storagePath(...segments: string[]): string {
  return path.join(storageRoot, ...segments);
}

function fileStat(type: number): FileStat {
  return { type, ctime: 0, mtime: 0, size: 1 };
}

function missing(target: string): Error {
  return errnoError('ENOENT', `Missing: ${target}`);
}

describe('inspectRunStorageEntry', () => {
  beforeEach(() => {
    StorageFS.fullPath = (target) => path.join(storageRoot, target);
  });

  afterEach(() => {
    StorageFS.stat = originalStat;
    StorageFS.fullPath = originalFullPath;
  });

  it('returns a canonical location for a regular primary-layout file', async () => {
    StorageFS.stat = async (target) => {
      if (target === primaryEntry('r1', 'draft.tex')) {
        return fileStat(FileType.File);
      }
      if (target === primaryEntry() || target === primaryEntry('r1')) {
        return fileStat(FileType.Directory);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntry(runId, 'r1\\draft.tex'),
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
      StorageFS.stat = async () => fileStat(type);

      await expect(
        inspectRunStorageEntry(runId, 'result.tex'),
      ).resolves.toMatchObject({ kind });
    },
  );

  it('distinguishes missing entries from invalid paths', async () => {
    StorageFS.stat = async (target) => {
      throw missing(target);
    };

    await expect(inspectRunStorageEntry(runId, 'missing.tex')).resolves.toEqual(
      { kind: 'missing' },
    );
    await expect(
      inspectRunStorageEntry(runId, '../outside.tex'),
    ).resolves.toMatchObject({ kind: 'invalid' });
    await expect(
      inspectRunStorageEntry(runId, '/outside.tex'),
    ).resolves.toMatchObject({ kind: 'invalid' });
  });

  it('rejects a regular file reached through an ancestor symlink', async () => {
    StorageFS.stat = async (target) => {
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
      inspectRunStorageEntry(runId, 'r1/link/result.tex'),
    ).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: storagePath('executions', runId, 'r1', 'link'),
    });
  });

  it('rejects a dangling ancestor symlink before treating the leaf as missing', async () => {
    const inspected: string[] = [];
    StorageFS.stat = async (target) => {
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
      inspectRunStorageEntry(runId, 'dangling/result.tex'),
    ).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: storagePath('executions', runId, 'dangling'),
    });
    expect(inspected).not.toContain(primaryEntry('dangling', 'result.tex'));
  });

  it('does not turn storage permission failures into a missing entry', async () => {
    StorageFS.stat = async () => {
      throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    };

    await expect(inspectRunStorageEntry(runId, 'result.tex')).rejects.toThrow(
      'Denied',
    );
  });

  it('recovers run identity from absolute run-storage paths', () => {
    expect(
      runStorageLocationFromAnyAbsolutePath(
        storagePath('executions', runId, 'r2', 'result.tex'),
      ),
    ).toMatchObject({
      kind: 'runStorage',
      runId,
      relativePath: 'r2/result.tex',
    });
    expect(
      runStorageLocationFromAnyAbsolutePath(
        path.join(workspaceRoot, 'result.tex'),
      ),
    ).toBeUndefined();
  });

  it('preserves source provenance instead of treating workspace inputs as outputs', () => {
    const fileService = new TaskRunFileService(runId);

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
