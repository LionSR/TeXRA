import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { withExpandedRunInputs } from '@cli/runtime/workflowInputs';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { createFakeHost, installFakeHost } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('CLI workflow input lifecycle', () => {
  const tempDirs = useTempDirs();
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('texra-cli-stdin-', tempDirs);
  });

  async function installFakePlatform() {
    const host = createFakeHost({
      globalStoragePath: path.join(root, 'global-storage'),
      storagePath: path.join(root, 'workspace-storage'),
      workspacePath: root,
    });
    await installFakeHost(host);
    return host.platform;
  }

  it.live('removes materialized stdin input on platform shutdown', () =>
    Effect.gen(function* () {
      const fakePlatform = yield* Effect.promise(installFakePlatform);
      const runtime = ManagedRuntime.make(Layer.empty);
      fakePlatform.lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
        runtime.dispose(),
      );
      const materialized = yield* Deferred.make<string>();
      const running = runtime.runFork(
        withExpandedRunInputs(
          ['-'],
          [],
          root,
          { readStdinText: async () => 'body from stdin' },
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
      expect(yield* Effect.promise(() => fs.readFile(inputPath, 'utf8'))).toBe(
        'body from stdin',
      );
      yield* Effect.promise(() => fakePlatform.lifecycle.runShutdown());
      expect(yield* Fiber.await(running)).toMatchObject({ _tag: 'Failure' });
      yield* Effect.promise(async () => {
        await expect(fs.stat(inputPath)).rejects.toThrow();
      });
    }),
  );

  it.live(
    'does not wait for unfinished stdin reads during platform shutdown',
    () =>
      Effect.gen(function* () {
        const fakePlatform = yield* Effect.promise(installFakePlatform);
        const runtime = ManagedRuntime.make(Layer.empty);
        fakePlatform.lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
          runtime.dispose(),
        );
        const reading = yield* Deferred.make<void>();
        const running = runtime.runFork(
          withExpandedRunInputs(
            ['-'],
            [],
            root,
            {
              readStdinText: () => {
                Deferred.doneUnsafe(reading, Effect.void);
                return new Promise<string>(() => undefined);
              },
            },
            () => Effect.void,
          ),
        );
        yield* Deferred.await(reading);
        const result = yield* Effect.promise(() =>
          Promise.race([
            fakePlatform.lifecycle.runShutdown().then(() => 'shutdown'),
            sleep(100).then(() => 'timeout'),
          ]),
        );
        expect(result).toBe('shutdown');
        expect(yield* Fiber.await(running)).toMatchObject({ _tag: 'Failure' });
        const entries = yield* Effect.promise(() => fs.readdir(root));
        expect(
          entries.filter((entry) => entry.startsWith('texra-stdin-')),
        ).toEqual([]);
      }),
  );

  it.live(
    'removes materialized stdin input when the headless run callback fails',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(installFakePlatform);
        let materializedPath = '';
        const failure = yield* Effect.flip(
          withExpandedRunInputs(
            ['-'],
            [],
            root,
            { readStdinText: async () => 'body from stdin' },
            ({ inputFiles }) =>
              Effect.gen(function* () {
                materializedPath = path.resolve(root, inputFiles[0]);
                expect(
                  yield* Effect.promise(() =>
                    fs.readFile(materializedPath, 'utf8'),
                  ),
                ).toBe('body from stdin');
                return yield* Effect.fail(new Error('run failed'));
              }),
          ),
        );
        expect(failure.message).toBe('run failed');
        yield* Effect.promise(async () => {
          await expect(fs.stat(materializedPath)).rejects.toThrow();
        });
      }),
  );
});
