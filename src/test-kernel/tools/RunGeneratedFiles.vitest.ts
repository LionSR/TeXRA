import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { listRunGeneratedFiles } from '@tools/executions/runGeneratedFiles';

const EXECUTION_ID = 'generated-history-test' as ExecutionId;
const STORAGE_PATH = path.join(path.sep, 'storage');
const RUN_PATH = path.join(STORAGE_PATH, 'executions', EXECUTION_ID);

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failStatFor(targetPath: string, error: Error): void {
  const fs = platform().fs;
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
    if (candidate === targetPath) throw error;
    return stat(candidate);
  });
}

describe('listRunGeneratedFiles', () => {
  setupPlatform({
    storagePath: STORAGE_PATH,
    files: {
      [path.join(RUN_PATH, 'sub', 'nested.tex')]: 'nested',
      [path.join(RUN_PATH, 'z.tex')]: 'xyz',
      [path.join(RUN_PATH, 'vanished.tex')]: 'gone',
      [path.join(RUN_PATH, 'blocked.tex')]: 'blocked',
      [path.join(RUN_PATH, 'unreadable.tex')]: 'unreadable',
      // A KV-*named* directory is internal metadata all the way down: the walk
      // must skip it before recursing, or its children leak into the listing.
      [path.join(RUN_PATH, 'turn-state.json', 'buried.tex')]: 'buried',
    },
  });
  let session: SessionHandle;
  beforeEach(() => {
    session = createProcessSession();
  });
  afterEach(() => vi.restoreAllMocks());

  it.effect(
    'lists in path order, skipping KV-named subtrees and concurrent disappearance',
    () =>
      Effect.gen(function* () {
        failStatFor(
          path.join(RUN_PATH, 'vanished.tex'),
          fsError('ENOENT', 'entry disappeared after readDir'),
        );

        expect(yield* listRunGeneratedFiles(EXECUTION_ID, session)).toEqual([
          { path: 'blocked.tex', size: 7, isDirectory: false },
          { path: 'sub', size: 0, isDirectory: true },
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
        failStatFor(
          path.join(RUN_PATH, 'blocked.tex'),
          fsError('ENOTDIR', 'parent path is no longer a directory'),
        );

        const files = yield* listRunGeneratedFiles(EXECUTION_ID, session);

        expect(files.map((file) => file.path)).not.toContain('blocked.tex');
      }),
  );

  it.effect('propagates operational stat failures', () =>
    Effect.gen(function* () {
      const error = fsError('EACCES', 'generated file is unreadable');
      failStatFor(path.join(RUN_PATH, 'unreadable.tex'), error);

      expect(
        yield* Effect.flip(listRunGeneratedFiles(EXECUTION_ID, session)),
      ).toBe(error);
    }),
  );
});
