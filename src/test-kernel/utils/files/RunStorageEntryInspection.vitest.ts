// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect, it } from 'vitest';
import { processWorkspaceRoots } from '@platform/workspaceRoots';

// Local imports
import type { RunId } from '@shared/schemas';
import { errnoError, nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  inspectRunStorageEntryUnder,
  runStorageLocationUnder,
} from '@utils/files/runStorageFs';
import { RunFileService } from '@utils/files/runStorage';

const runId = 'abcdef123456' as RunId;
const storageRoot = path.resolve(path.sep, 'storage');
const workspaceRoot = path.resolve(path.sep, 'workspace');

setupPlatform({ storagePath: storageRoot, workspacePath: workspaceRoot });

function storagePath(...segments: string[]): string {
  return path.join(storageRoot, ...segments);
}

/** The absolute path the rooted helper probes for a run-relative entry. */
function primaryEntry(...segments: string[]): string {
  return storagePath('executions', runId, ...segments);
}

/**
 * The entry type each probed path reports, per case. The walk reads run
 * storage through the process filesystem, so a case seeds the answer there —
 * including the readings no temp tree builds portably (an unreadable entry,
 * an unsupported node type).
 */
type EntryProbe = (
  target: string,
) => Effect.Effect<FileSystem.File.Type, PlatformError.PlatformError>;

let probe: EntryProbe = (target) => missing(target);

const entryType = (
  type: FileSystem.File.Type,
): Effect.Effect<FileSystem.File.Type> => Effect.succeed(type);

/** How the filesystem reports a path that is not there, and one it may not read. */
function probeFailure(
  reason: 'NotFound' | 'PermissionDenied',
  target: string,
  cause: NodeJS.ErrnoException,
): Effect.Effect<never, PlatformError.PlatformError> {
  return Effect.fail(
    PlatformError.systemError({
      _tag: reason,
      module: 'FileSystem',
      method: 'stat',
      pathOrDescriptor: target,
      cause,
    }),
  );
}

function missing(target: string) {
  return probeFailure(
    'NotFound',
    target,
    errnoError('ENOENT', `Missing: ${target}`),
  );
}

/** The walk over a filesystem whose readings are this case's. */
const inspect = (relativePath: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const processFs = yield* FileSystem.FileSystem;
      const info = { ...(yield* processFs.stat('/')), type: 'File' as const };
      return yield* inspectRunStorageEntryUnder(
        storageRoot,
        runId,
        relativePath,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...processFs,
          // A link answers `readLink`; everything else, and every probe
          // failure, falls through to the stat below.
          readLink: (target: string) =>
            probe(target).pipe(
              Effect.flatMap((type) =>
                type === 'SymbolicLink'
                  ? Effect.succeed(target)
                  : missing(target),
              ),
            ),
          stat: (target: string) =>
            probe(target).pipe(Effect.map((type) => ({ ...info, type }))),
        }),
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

describe('inspectRunStorageEntryUnder', () => {
  it('returns a canonical location for a regular primary-layout file', async () => {
    probe = (target) => {
      if (target === primaryEntry('r1', 'draft.tex')) return entryType('File');
      if (target === primaryEntry() || target === primaryEntry('r1')) {
        return entryType('Directory');
      }
      return missing(target);
    };

    await expect(inspect('r1\\draft.tex')).resolves.toEqual({
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
    { type: 'SymbolicLink', kind: 'symlink' },
    { type: 'Directory', kind: 'directory' },
    { type: 'Unknown', kind: 'unsupported' },
  ] as const)(
    'classifies a non-bindable entry as $kind',
    async ({ type, kind }) => {
      probe = () => entryType(type);

      await expect(inspect('result.tex')).resolves.toMatchObject({ kind });
    },
  );

  it('distinguishes missing entries from invalid paths', async () => {
    probe = (target) => missing(target);

    await expect(inspect('missing.tex')).resolves.toEqual({ kind: 'missing' });
    await expect(inspect('../outside.tex')).resolves.toMatchObject({
      kind: 'invalid',
    });
    await expect(inspect('/outside.tex')).resolves.toMatchObject({
      kind: 'invalid',
    });
  });

  it('rejects a regular file reached through an ancestor symlink', async () => {
    probe = (target) => {
      if (target.endsWith(path.join('link', 'result.tex'))) {
        return entryType('File');
      }
      if (target === primaryEntry()) return entryType('Directory');
      if (target === primaryEntry('r1')) return entryType('Directory');
      if (target === primaryEntry('r1', 'link')) {
        return entryType('SymbolicLink');
      }
      return missing(target);
    };

    await expect(inspect('r1/link/result.tex')).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: storagePath('executions', runId, 'r1', 'link'),
    });
  });

  it('rejects a dangling ancestor symlink before treating the leaf as missing', async () => {
    const inspected: string[] = [];
    probe = (target) => {
      inspected.push(target);
      if (target === primaryEntry()) return entryType('Directory');
      if (target === primaryEntry('dangling')) {
        return entryType('SymbolicLink');
      }
      return missing(target);
    };

    await expect(inspect('dangling/result.tex')).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: storagePath('executions', runId, 'dangling'),
    });
    expect(inspected).not.toContain(primaryEntry('dangling', 'result.tex'));
  });

  it('does not turn storage permission failures into a missing entry', async () => {
    probe = (target) =>
      probeFailure('PermissionDenied', target, errnoError('EACCES', 'Denied'));

    await expect(inspect('result.tex')).rejects.toThrow('PermissionDenied');
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
    const fileService = new RunFileService(runId, processWorkspaceRoots());

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
