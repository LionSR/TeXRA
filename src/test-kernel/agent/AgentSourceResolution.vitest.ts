// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Effect, Layer } from 'effect';
import { it } from '@effect/vitest';
import { afterAll, beforeAll, describe, expect } from 'vitest';

// Local imports
import {
  AgentCatalog,
  findAgentByIdentifier,
  type AgentCatalogShape,
} from '@agent/index/agentCatalog';
import type { AgentEntry } from '@agent/index/agentEntry';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { GlobalStorageFs } from '@platform/rootedFs';
import { FakeStateStore } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  fakeHostAgentDirectories,
  hostStores,
  installPlatform,
  storePluginsLayer,
} from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

/** The suite's catalog, loaded once the fake host is installed. */
let catalog: AgentCatalogShape;

/** Resolve exactly as launch does: through the single launch resolver, by the
 * source the delegation captured at validation time (see `getAgentPath`). */
function launchAs(entry: AgentEntry | undefined) {
  return entry
    ? catalog.forLaunch(hostStores(), entry.name, entry.source)
    : Effect.succeed(undefined);
}

/**
 * A custom agent named `assistant` shadows the bundled `assistant`. A bare
 * name resolves to the higher-priority custom entry; a delegation that
 * validated the built-in carries the entry's *source*, and launch resolves the
 * exact `(source, name)` key, so it cannot diverge from what validation
 * accepted.
 */
describe('shadowed agent resolution', () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const customAgents: Record<string, string[]> = {
      'assistant.yaml': [
        'name: assistant',
        'description: Custom document task that shadows a built-in name.',
        'prompt: Custom assistant.',
        'task:',
        '  requests:',
        '    - Revise the documents.',
      ],
    };
    const customDir = await makeTempDir('texra-custom-agent-', tempDirs);
    for (const [fileName, lines] of Object.entries(customAgents)) {
      await writeFile(resolve(customDir, fileName), `${lines.join('\n')}\n`);
    }

    await installPlatform(
      {},
      {
        agentDirectories: {
          custom: () => Effect.sync(() => customDir),
          customConfigured: () => Effect.succeed(false),
          builtIn: () =>
            Effect.sync(() =>
              resolve(REPO_ROOT, 'packages/extension/resources/agents'),
            ),
        },
      },
    );

    // The fake host answers `custom()` from a temp directory of its own, so
    // nothing in this load reaches the global storage view.
    catalog = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const loaded = yield* AgentCatalog;
          yield* loaded.refresh;
          return loaded;
        }),
        AgentCatalog.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(GlobalStorageFs)({} as RootedFileSystem),
              AgentDirectories.layer(fakeHostAgentDirectories),
              AppState.layer(new FakeStateStore()),
              nodePlatformLayer,
              testHttpClientLayer,
              storePluginsLayer,
            ),
          ),
        ),
      ),
    );
  });

  afterAll(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it.effect(
    'pins launch to the exact (source, name) entry validation captured',
    () =>
      Effect.gen(function* () {
        const builtIn = yield* launchAs(catalog.get('builtIn:assistant'));
        expect(builtIn?.source).toBe('builtIn');

        // The entry validation accepts: the name within the visible agents.
        const visible = yield* catalog.visible(hostStores());
        const custom = yield* launchAs(
          findAgentByIdentifier(visible, 'assistant'),
        );
        expect(custom?.source).toBe('custom');
      }),
  );
});
