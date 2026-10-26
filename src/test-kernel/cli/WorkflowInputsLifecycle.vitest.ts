import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Deferred, Effect, Exit, Fiber, ManagedRuntime, Scope } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { withExpandedRunInputs } from '@cli/runtime/workflowInputs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
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
      expect(yield* Effect.promise(() => fs.readFile(inputPath, 'utf8'))).toBe(
        'body from stdin',
      );
      yield* Scope.close(fakePlatform.shutdownScope, Exit.void);
      expect(yield* Fiber.await(running)).toMatchObject({ _tag: 'Failure' });
      yield* Effect.promise(async () => {
        await expect(fs.stat(inputPath)).rejects.toThrow();
      });
    }),
  );
});
