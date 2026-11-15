import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Deferred, Effect, Exit, Fiber, ManagedRuntime, Scope } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { withExpandedRunInputs } from '@cli/runtime/headless/documentTaskInputs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { createFakeHost } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost } from '@test/support/testKernel';

describe('CLI workflow input lifecycle', () => {
  const tempDirs = useTempDirs();
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('texra-cli-stdin-', tempDirs);
  });

  // Live clock: the subject's shutdown and its runtime run in real time.
  it.layer(
    FakeHost.layer(() =>
      createFakeHost({
        globalStoragePath: path.join(root, 'global-storage'),
        storagePath: path.join(root, 'workspace-storage'),
        workspaceRoot: root,
      }),
    ),
    { buildPerTest: true, excludeTestServices: true },
  )((it) => {
    it.effect('keeps media inputs out of the text inputs', () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all(
            ['paper.tex', 'figure.png'].map((name) =>
              fs.writeFile(path.join(root, name), ''),
            ),
          ),
        );
        const expanded = yield* withExpandedRunInputs(
          ['paper.tex', 'figure.png'],
          [],
          root,
          {},
          ({ inputFiles, mediaFiles }) =>
            Effect.succeed({ inputFiles, mediaFiles }),
        ).pipe(Effect.provide(nodePlatformLayer));
        expect(expanded).toEqual({
          inputFiles: ['paper.tex'],
          mediaFiles: ['figure.png'],
        });
      }),
    );

    it.effect('removes materialized stdin input on platform shutdown', () =>
      Effect.gen(function* () {
        const fakePlatform = (yield* FakeHost).platform;
        const runtime = ManagedRuntime.make(nodePlatformLayer);
        yield* Scope.addFinalizer(
          fakePlatform.shutdownScope,
          runtime.disposeEffect,
        );
        const materialized = yield* Deferred.make<string>();
        const running = runtime.runFork(
          withExpandedRunInputs(
            ['-'],
            [],
            root,
            { readStdinText: Effect.succeed('body from stdin') },
            ({ inputFiles }) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(
                  materialized,
                  path.resolve(root, inputFiles[0]),
                );
                yield* Effect.never;
              }),
          ),
        );
        const inputPath = yield* Deferred.await(materialized);
        expect(
          yield* Effect.promise(() => fs.readFile(inputPath, 'utf8')),
        ).toBe('body from stdin');
        yield* Scope.close(fakePlatform.shutdownScope, Exit.void);
        expect(yield* Fiber.await(running)).toMatchObject({ _tag: 'Failure' });
        yield* Effect.promise(async () => {
          await expect(fs.stat(inputPath)).rejects.toThrow();
        });
      }),
    );
  });
});
