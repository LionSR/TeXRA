import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileType, type FileStat } from '@platform/interfaces';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';
import {
  inspectRunStorageEntry,
  runStorageLocationFromAnyAbsolutePath,
} from '@utils/files/taskRunStorage';

const executionId = 'abcdef123456' as ExecutionId;
const originalStat = StorageFS.stat;
const originalFullPath = StorageFS.fullPath;

function fileStat(type: number): FileStat {
  return { type, ctime: 0, mtime: 0, size: 1 };
}

function missing(target: string): Error {
  return Object.assign(new Error(`Missing: ${target}`), { code: 'ENOENT' });
}

describe('inspectRunStorageEntry', () => {
  beforeEach(() => {
    StorageFS.fullPath = (target) => `/storage/${target}`;
  });

  afterEach(() => {
    StorageFS.stat = originalStat;
    StorageFS.fullPath = originalFullPath;
  });

  it('returns a canonical location for a regular primary-layout file', async () => {
    StorageFS.stat = async (target) => {
      if (target === `executions/${executionId}/r1/draft.tex`) {
        return fileStat(FileType.File);
      }
      if (
        target === `executions/${executionId}` ||
        target === `executions/${executionId}/r1`
      ) {
        return fileStat(FileType.Directory);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntry(executionId, 'r1\\draft.tex'),
    ).resolves.toEqual({
      kind: 'file',
      location: {
        kind: 'runStorage',
        absolutePath: `/storage/executions/${executionId}/r1/draft.tex`,
        relativePath: 'r1/draft.tex',
        executionId,
      },
    });
  });

  it('falls back to the legacy layout only when the primary entry is absent', async () => {
    StorageFS.stat = async (target) => {
      if (target === `taskRuns/${executionId}/result.tex`) {
        return fileStat(FileType.File);
      }
      if (target === `taskRuns/${executionId}`) {
        return fileStat(FileType.Directory);
      }
      throw missing(target);
    };

    const result = await inspectRunStorageEntry(executionId, 'result.tex');

    expect(result).toMatchObject({
      kind: 'file',
      location: {
        absolutePath: `/storage/taskRuns/${executionId}/result.tex`,
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
        inspectRunStorageEntry(executionId, 'result.tex'),
      ).resolves.toMatchObject({ kind });
    },
  );

  it('distinguishes missing entries from invalid paths', async () => {
    StorageFS.stat = async (target) => {
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntry(executionId, 'missing.tex'),
    ).resolves.toEqual({ kind: 'missing' });
    await expect(
      inspectRunStorageEntry(executionId, '../outside.tex'),
    ).resolves.toMatchObject({ kind: 'invalid' });
    await expect(
      inspectRunStorageEntry(executionId, '/outside.tex'),
    ).resolves.toMatchObject({ kind: 'invalid' });
  });

  it('rejects a regular file reached through an ancestor symlink', async () => {
    StorageFS.stat = async (target) => {
      if (target.endsWith('/link/result.tex')) {
        return fileStat(FileType.File);
      }
      if (target === `executions/${executionId}`) {
        return fileStat(FileType.Directory);
      }
      if (target === `executions/${executionId}/r1`) {
        return fileStat(FileType.Directory);
      }
      if (target === `executions/${executionId}/r1/link`) {
        return fileStat(FileType.SymbolicLink | FileType.Directory);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntry(executionId, 'r1/link/result.tex'),
    ).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: `/storage/executions/${executionId}/r1/link`,
    });
  });

  it('rejects a dangling ancestor symlink before treating the leaf as missing', async () => {
    const inspected: string[] = [];
    StorageFS.stat = async (target) => {
      inspected.push(target);
      if (target === `executions/${executionId}`) {
        return fileStat(FileType.Directory);
      }
      if (target === `executions/${executionId}/dangling`) {
        return fileStat(FileType.SymbolicLink | FileType.Unknown);
      }
      throw missing(target);
    };

    await expect(
      inspectRunStorageEntry(executionId, 'dangling/result.tex'),
    ).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: `/storage/executions/${executionId}/dangling`,
    });
    expect(inspected).not.toContain(
      `executions/${executionId}/dangling/result.tex`,
    );
  });

  it('does not turn storage permission failures into a missing entry', async () => {
    StorageFS.stat = async () => {
      throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    };

    await expect(
      inspectRunStorageEntry(executionId, 'result.tex'),
    ).rejects.toThrow('Denied');
  });

  it('recovers execution identity from current and legacy absolute paths', () => {
    expect(
      runStorageLocationFromAnyAbsolutePath(
        `/storage/executions/${executionId}/r2/result.tex`,
      ),
    ).toMatchObject({
      kind: 'runStorage',
      executionId,
      relativePath: 'r2/result.tex',
    });
    expect(
      runStorageLocationFromAnyAbsolutePath(
        `/storage/taskRuns/${executionId}/result.tex`,
      ),
    ).toMatchObject({
      kind: 'runStorage',
      executionId,
      relativePath: 'result.tex',
    });
    expect(
      runStorageLocationFromAnyAbsolutePath('/workspace/result.tex'),
    ).toBeUndefined();
  });
});
