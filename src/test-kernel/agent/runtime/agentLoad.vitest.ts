import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterAll, beforeAll, describe } from 'vitest';

import { AgentCatalog } from '@agent/index/agentCatalog';
import {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import { FakeStateStore } from '@test/support/FakePlatform';
import {
  fakeHostAgentDirectories,
  installPlatform,
  storePluginsLayer,
} from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

/**
 * A catalog over the process's global storage view. Nothing under test here
 * reads it: the fake agent directories answer `custom()` themselves, so this
 * only satisfies the requirement the catalog names.
 */
const newCatalog = Effect.provide(
  Effect.gen(function* () {
    return yield* AgentCatalog;
  }),
  AgentCatalog.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        unusedGlobalStorageFs(),
        storePluginsLayer,
        nodePlatformLayer,
        testHttpClientLayer,
        AgentDirectories.layer(fakeHostAgentDirectories),
        AppState.layer(new FakeStateStore()),
      ),
    ),
  ),
);

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
      const catalog = yield* newCatalog;
      const counter = { scans: 0 };
      yield* Effect.promise(() =>
        installDirectories(countingDirectories(counter)),
      );
      yield* catalog.refresh;
      assert.strictEqual(catalog.get('custom:stateProbe')?.name, 'stateProbe');

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
        }),
      );

      const error = yield* Effect.flip(catalog.refresh);
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, scanFailure.message);

      // A failed rebuild leaves the previously published catalog in place.
      assert.strictEqual(catalog.get('custom:stateProbe')?.name, 'stateProbe');
    }),
  );
});
