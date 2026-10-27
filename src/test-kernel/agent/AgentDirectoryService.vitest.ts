// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { AgentDirectoryService } from '@agent/index/AgentDirectoryService';
import { globalStorageFsLayer } from '@platform/rootedFs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('AgentDirectoryService', () => {
  const tempDirs = useTempDirs();

  // A rejected configured path falls back loudly: the person is told why,
  // and the path does not count as configured.
  it.live(
    'falls back to the default custom directory for a relative configured path',
    () =>
      Effect.gen(function* () {
        const storageBase = yield* Effect.promise(() =>
          makeTempDir('texra-agent-dirs-', tempDirs),
        );
        const reports: Array<{ message: string; docsId: string }> = [];
        const service = new AgentDirectoryService({
          channel: 'AgentDirectoryServiceTest',
          resourcesPath: path.resolve('/texra-resources'),
          state: { get: () => Effect.succeed('relative/custom') },
          issueReporter: {
            report: (message, docsId) =>
              Effect.sync(() => {
                reports.push({ message, docsId });
              }),
          },
        });
        const layer = Layer.merge(
          Layer.provide(globalStorageFsLayer(storageBase), nodePlatformLayer),
          nodePlatformLayer,
        );

        const custom = yield* service.custom().pipe(Effect.provide(layer));
        expect(custom).toBe(path.join(storageBase, 'custom_agents'));
        expect(reports).toEqual([
          {
            message: 'Custom agents directory must be an absolute path',
            docsId: 'custom-agents',
          },
        ]);
        expect(
          yield* service.customConfigured().pipe(Effect.provide(layer)),
        ).toBe(false);
      }),
  );
});
