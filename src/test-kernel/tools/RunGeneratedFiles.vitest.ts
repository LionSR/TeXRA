import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { listRunGeneratedFiles } from '@tools/executions/runGeneratedFiles';

const EXECUTION_ID = 'generated-history-test' as RunId;
const STORAGE_PATH = fakePath('storage');
const RUN_PATH = path.join(STORAGE_PATH, 'executions', EXECUTION_ID);

function statFailure(
  tag: PlatformError.SystemErrorTag,
  target: string,
): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: tag,
    module: 'FileSystem',
    method: 'stat',
    pathOrDescriptor: target,
  });
}

/**
 * The process filesystem with one path's `stat` failing: the walk's own
 * failure policy is what these cases exercise, and a real race between the
 * listing and the stat cannot be staged on disk.
 */
function withFailingStat(
  fs: FileSystem.FileSystem,
  target: string,
  failure: PlatformError.PlatformError,
): FileSystem.FileSystem {
  return {
    ...fs,
    stat: (candidate: string) =>
      candidate === target ? Effect.fail(failure) : fs.stat(candidate),
  };
}

/** The listing, with `target`'s `stat` failing as `tag`. */
const listWithFailedStat = (
  session: SessionHandle,
  target: string,
  failure: PlatformError.PlatformError,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* listRunGeneratedFiles(EXECUTION_ID, session).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        withFailingStat(fs, target, failure),
      ),
    );
  }).pipe(Effect.provide(nodePlatformLayer));

describe('listRunGeneratedFiles', () => {
  setupPlatform({
    storagePath: STORAGE_PATH,
    files: {
      [path.join(RUN_PATH, 'sub', 'nested.tex')]: 'nested',
      [path.join(RUN_PATH, 'z.tex')]: 'xyz',
      [path.join(RUN_PATH, 'vanished.tex')]: 'gone',
      [path.join(RUN_PATH, 'blocked.tex')]: 'blocked',
      [path.join(RUN_PATH, 'unreadable.tex')]: 'unreadable',
    },
  });
  let session: SessionHandle;
  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  it.effect(
    'lists in path order, skipping entries that disappear concurrently',
    () =>
      Effect.gen(function* () {
        const vanished = path.join(RUN_PATH, 'vanished.tex');

        expect(
          yield* listWithFailedStat(
            session,
            vanished,
            statFailure('NotFound', vanished),
          ),
        ).toEqual([
          { path: 'blocked.tex', size: 7, isDirectory: false },
          // A real directory's size is the filesystem's own bookkeeping.
          { path: 'sub', size: expect.any(Number), isDirectory: true },
          { path: 'sub/nested.tex', size: 6, isDirectory: false },
          { path: 'unreadable.tex', size: 10, isDirectory: false },
          { path: 'z.tex', size: 3, isDirectory: false },
        ]);
      }),
  );

  it.effect(
    'omits an entry whose intermediate component is no longer a directory',
    () =>
      Effect.gen(function* () {
        const blocked = path.join(RUN_PATH, 'blocked.tex');

        const files = yield* listWithFailedStat(
          session,
          blocked,
          statFailure('BadResource', blocked),
        );

        expect(files.map((file) => file.path)).not.toContain('blocked.tex');
      }),
  );

  it.effect('propagates operational stat failures', () =>
    Effect.gen(function* () {
      const unreadable = path.join(RUN_PATH, 'unreadable.tex');
      const failure = statFailure('PermissionDenied', unreadable);

      expect(
        yield* Effect.flip(listWithFailedStat(session, unreadable, failure)),
      ).toBe(failure);
    }),
  );
});
