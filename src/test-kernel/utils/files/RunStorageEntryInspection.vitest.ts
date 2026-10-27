// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect, it } from 'vitest';
import type { RunId } from '@shared/schemas';

// Local imports
import { errnoError, nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { RunFileService } from '@utils/files/runStorage';

const runId = 'abcdef123456' as RunId;
const storageRoot = path.resolve(path.sep, 'storage');
const workspaceRoot = path.resolve(path.sep, 'workspace');

setupPlatform({ storagePath: storageRoot, workspacePath: workspaceRoot });

/** The absolute path the rooted helper probes for a run-relative entry. */
function primaryEntry(...segments: string[]): string {
  return path.join(storageRoot, 'executions', runId, ...segments);
}

/**
 * The entry type each probed path reports. The walk reads run storage through
 * the process filesystem, so the case seeds the answer there; any other path
 * reads as missing.
 */
const probed = new Map<string, FileSystem.File.Type>([
  [primaryEntry(), 'Directory'],
  [primaryEntry('r1'), 'Directory'],
  [primaryEntry('r1', 'link'), 'SymbolicLink'],
  [primaryEntry('r1', 'link', 'result.tex'), 'File'],
]);

function probe(
  target: string,
): Effect.Effect<FileSystem.File.Type, PlatformError.PlatformError> {
  const type = probed.get(target);
  return type
    ? Effect.succeed(type)
    : Effect.fail(
        PlatformError.systemError({
          _tag: 'NotFound',
          module: 'FileSystem',
          method: 'stat',
          pathOrDescriptor: target,
          cause: errnoError('ENOENT', `Missing: ${target}`),
        }),
      );
}

/** The walk over a filesystem whose readings are this case's. */
const inspect = (relativePath: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const processFs = yield* FileSystem.FileSystem;
      const info = { ...(yield* processFs.stat('/')), type: 'File' as const };
      return yield* new RunFileService(runId, {
        storage: storageRoot,
        workspace: workspaceRoot,
      })
        .inspectEntry(relativePath)
        .pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...processFs,
            // The entry probe is one `lstat`: each path reports its case type.
            lstat: (target: string) =>
              probe(target).pipe(Effect.map((type) => ({ ...info, type }))),
          }),
        );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

describe('RunFileService.inspectEntry', () => {
  it('rejects a regular file reached through an ancestor symlink', async () => {
    await expect(inspect('r1/link/result.tex')).resolves.toMatchObject({
      kind: 'symlink',
      absolutePath: primaryEntry('r1', 'link'),
    });
  });
});
