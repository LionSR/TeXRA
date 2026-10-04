import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterAll, beforeAll, describe } from 'vitest';

import { getAgent, refresh } from '@agent/index';
import {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { FakeStateStore } from '@test/support/FakePlatform';
import {
  fakeHostAgentDirectories,
  installPlatform,
} from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

/**
 * A program over the process's global storage view. Nothing under test here
 * reads it: the fake agent directories answer `custom()` themselves, so this
 * only satisfies the requirement the catalog readers name.
 */
function onGlobalStorage<A, E>(
  program: Effect.Effect<A, E, AgentCatalogServices>,
): Effect.Effect<A, E> {
  return Effect.provide(
    program,
    Layer.mergeAll(
      unusedGlobalStorageFs(),
      nodePlatformLayer,
      testHttpClientLayer,
      AgentDirectories.layer(fakeHostAgentDirectories),
      AppState.layer(new FakeStateStore()),
    ),
  );
}

const tempDirs: string[] = [];

afterAll(async () => {
  await cleanupTempDirs(tempDirs);
});

describe('agent registry load state', () => {
  let agentDir = '';

  async function installDirectories(
    directories: AgentDirectoriesPort,
  ): Promise<void> {
    await installPlatform({}, { agentDirectories: directories });
  }

  function countingDirectories(counter: {
    scans: number;
  }): AgentDirectoriesPort {
    return {
      custom: () =>
        Effect.sync(() => {
          counter.scans += 1;
          return agentDir;
        }),
      customConfigured: () => Effect.succeed(false),
      builtIn: () => Effect.sync(() => agentDir),
      builtInToolUse: () => Effect.sync(() => agentDir),
    };
  }

  beforeAll(async () => {
    agentDir = await makeTempDir('texra-load-state-', tempDirs);
    await writeFile(
      path.join(agentDir, 'stateProbe.yaml'),
      [
        'name: stateProbe',
        'description: Probe agent for load-state tests.',
        'prompt: Probe.',
        '',
      ].join('\n'),
    );
  });

  it.effect('keeps serving the published catalog when a refresh fails', () =>
    Effect.gen(function* () {
      const counter = { scans: 0 };
      yield* Effect.promise(() =>
        installDirectories(countingDirectories(counter)),
      );
      yield* onGlobalStorage(refresh());
      assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');

      const scanFailure = new Error('agent directory unavailable');
      yield* Effect.promise(() =>
        installDirectories({
          custom: () =>
            Effect.fail(
              new AgentDirectoriesFailed({
                source: 'custom',
                message: scanFailure.message,
                cause: scanFailure,
              }),
            ),
          customConfigured: () => Effect.succeed(false),
          builtIn: () => Effect.sync(() => agentDir),
          builtInToolUse: () => Effect.sync(() => agentDir),
        }),
      );

      const error = yield* Effect.flip(onGlobalStorage(refresh()));
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, scanFailure.message);

      // A failed rebuild leaves the previously published catalog in place.
      assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');
    }),
  );
});
