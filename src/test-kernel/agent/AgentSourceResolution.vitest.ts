// Node imports
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Third-party imports
import { Effect, Layer } from 'effect';
import { layer } from '@effect/vitest';
import { afterAll, assert, expect } from 'vitest';

// Local imports
import {
  AgentCatalog,
  type AgentCatalogShape,
  AgentDirectories,
  type AgentEntry,
  AppState,
} from '@texra-ai/harness/host';
import { findAgentByIdentifier } from '@agent/index/agentCatalog';
import { FakeStateStore } from '@test/support/FakePlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  createFakeHost,
  fakeHostAgentDirectories,
  installedHost,
} from '@test/support/setupPlatform';
import { storePluginsLayer } from '@test/support/texraApp';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeHost } from '@test/support/testKernel';

/** Resolve exactly as launch does: through the single launch resolver, by the
 * source the delegation captured at validation time (see `getAgentPath`). */
function launchAs(catalog: AgentCatalogShape, entry: AgentEntry | undefined) {
  return entry
    ? catalog.forLaunch(installedHost().roots, entry.name, entry.source)
    : Effect.succeed(undefined);
}

const tempDirs: string[] = [];

/** The catalog, loaded over the installed fake host. The host answers
 *  `custom()` from a temp directory of its own, so nothing in this load
 *  reaches the global storage view. */
const loadCatalog = Effect.provide(
  Effect.gen(function* () {
    const loaded = yield* AgentCatalog;
    yield* loaded.refresh;
    return loaded;
  }),
  AgentCatalog.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        unusedGlobalStorageFs(),
        Layer.succeed(AgentDirectories)(fakeHostAgentDirectories),
        AppState.layer(new FakeStateStore()),
        nodePlatformLayer,
        testHttpClientLayer,
        storePluginsLayer,
      ),
    ),
  ),
);

/**
 * A custom agent named `assistant` shadows the bundled `assistant`. A bare
 * name resolves to the higher-priority custom entry; a delegation that
 * validated the built-in carries the entry's *source*, and launch resolves the
 * exact `(source, name)` key, so it cannot diverge from what validation
 * accepted.
 *
 * The block runs on the live clock, as a host's catalog load does.
 */
layer(
  FakeHost.layer(async () => {
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

    return createFakeHost(
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
  }),
  { excludeTestServices: true },
)('shadowed agent resolution', (it) => {
  afterAll(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it.effect(
    'pins launch to the exact (source, name) entry validation captured',
    () =>
      Effect.gen(function* () {
        const catalog = yield* loadCatalog;
        const builtIn = yield* launchAs(
          catalog,
          catalog.get('builtIn:assistant'),
        );
        expect(builtIn?.source).toBe('builtIn');

        // The entry validation accepts: the name within the visible agents.
        const visible = yield* catalog.visible(installedHost().roots);
        const custom = yield* launchAs(
          catalog,
          findAgentByIdentifier(visible, 'assistant'),
        );
        expect(custom?.source).toBe('custom');
      }),
  );

  // A bundled task that binds template files beside its YAML resolves them
  // beside its customized copy, so the copy must carry them.
  it.effect('copies the files a task binds beside its customized copy', () =>
    Effect.gen(function* () {
      const catalog = yield* loadCatalog;
      const bundled = catalog.get('builtIn:paper2poster');
      assert(bundled, 'the bundled paper2poster task is listed');

      const copy = yield* catalog.customize(bundled, 'copy');

      const template = (file: string) =>
        Effect.promise(() => readFile(file, 'utf8'));
      expect(
        yield* template(resolve(dirname(copy), 'template_poster.tex')),
      ).toBe(
        yield* template(resolve(dirname(bundled.path), 'template_poster.tex')),
      );
    }),
  );
});
