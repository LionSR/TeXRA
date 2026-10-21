// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Effect, FileSystem, Layer } from 'effect';
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
import { PersonaSchema } from '@shared/schemas';
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

/** The entry validation accepts: `identifier` within the visible agents. */
function visibleAgent(identifier: string) {
  return catalog
    .visible(hostStores())
    .pipe(Effect.map((entries) => findAgentByIdentifier(entries, identifier)));
}

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
      'review.yaml': [
        'name: review',
        'description: Custom agent that shadows a built-in name.',
        'prompt: Custom review agent.',
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

        const custom = yield* launchAs(yield* visibleAgent('assistant'));
        expect(custom?.source).toBe('custom');
      }),
  );

  it.effect(
    'resolves an unpinned launch through the same visible set as validation',
    () =>
      Effect.gen(function* () {
        // A direct launch without a pinned source (e.g. the webview "Run") routes
        // through the visible agents — the identical lookup validation makes.
        const unpinned = yield* catalog.forLaunch(hostStores(), 'assistant');
        expect(unpinned).toBe(yield* visibleAgent('assistant'));
        expect(unpinned?.source).toBe('custom');

        // A stale/missing pinned source falls through to that same visible-set tier.
        const stale = yield* catalog.forLaunch(
          hostStores(),
          'assistant',
          'plugin',
        );
        expect(stale?.source).toBe('custom');

        // A `source:name` key matches its exact entry, even a shadowed one.
        const keyed = yield* catalog.forLaunch(
          hostStores(),
          'builtIn:assistant',
        );
        expect(keyed?.source).toBe('builtIn');
      }),
  );

  // Failure mode: a pinned launch captures the old entry before the pending
  // source refresh, so an agent edited during the watcher debounce runs stale.
  it.live('launches the refreshed custom agent after invalidation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* catalog.forLaunch(
        hostStores(),
        'review',
        'custom',
      );
      const contents = yield* fs.readFileString(original.path);
      yield* Effect.addFinalizer(() =>
        fs
          .writeFileString(original.path, contents)
          .pipe(Effect.andThen(catalog.refresh), Effect.orDie),
      );
      yield* fs.writeFileString(
        original.path,
        'name: review\nprompt: Updated custom review agent.\n',
      );
      yield* catalog.invalidate;

      const launched = yield* catalog.forLaunch(
        hostStores(),
        'review',
        'custom',
      );
      expect(catalog.get('custom:review')?.persona.prompt).toBe(
        'Updated custom review agent.',
      );
      expect(launched.persona.prompt).toBe('Updated custom review agent.');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect('resolves scoped keys and drops unknown ones', () =>
    Effect.gen(function* () {
      const scoped = yield* catalog.visible(hostStores(), [
        'assistant',
        'builtIn:assistant',
        'missing-agent',
      ]);

      expect(scoped.map((entry) => `${entry.source}:${entry.name}`)).toEqual([
        'custom:assistant',
        'builtIn:assistant',
      ]);
    }),
  );

  it.effect(
    'preserves exact source-qualified agent list entries before name deduplication',
    () =>
      Effect.gen(function* () {
        // Both source-qualified identifiers must resolve to their own entry
        // (`custom:review` to the custom one, not the built-in it shadows), and
        // the deduplicated result must keep both, in scope order.
        const scoped = yield* catalog.visible(hostStores(), [
          'builtIn:review',
          'custom:review',
        ]);

        expect(scoped.map((entry) => `${entry.source}:${entry.name}`)).toEqual([
          'builtIn:review',
          'custom:review',
        ]);
      }),
  );
});

describe('findAgentByIdentifier (shared identity rule)', () => {
  function entry(name: string, source: AgentEntry['source']): AgentEntry {
    return {
      name,
      source,
      path: '',
      persona: PersonaSchema.parse({}),
      blocks: {},
    };
  }
  const entries = [entry('review', 'builtIn'), entry('review', 'custom')];

  it('matches a bare name by name (first candidate wins)', () => {
    expect(findAgentByIdentifier(entries, 'review')?.source).toBe('builtIn');
  });

  it('matches a source-qualified key only by exact key', () => {
    expect(findAgentByIdentifier(entries, 'custom:review')?.source).toBe(
      'custom',
    );
    // A key whose source is absent from the set must not fall back to the name.
    expect(findAgentByIdentifier(entries, 'remote:review')).toBeUndefined();
  });
});
