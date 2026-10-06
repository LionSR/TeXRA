// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Effect, Layer } from 'effect';
import { it } from '@effect/vitest';
import { afterAll, beforeAll, describe, expect } from 'vitest';

// Local imports
import {
  findAgentByIdentifier,
  getCatalogAgent,
  getVisibleAgents,
  refresh,
  resolveAgentForLaunch,
  resolveDelegationScopeAgents,
} from '@agent/index/agentRegistry';
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
} from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

/** The entry validation accepts: `identifier` within the visible agents. */
function visibleAgent(identifier: string) {
  return getVisibleAgents(hostStores()).pipe(
    Effect.map((entries) => findAgentByIdentifier(entries, identifier)),
  );
}

/** Resolve exactly as launch does: through the single launch resolver, by the
 * source the delegation captured at validation time (see `getAgentPath`). */
function launchAs(entry: AgentEntry | undefined) {
  return entry
    ? resolveAgentForLaunch(hostStores(), entry.name, entry.source)
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
          builtInToolUse: () =>
            Effect.sync(() =>
              resolve(
                REPO_ROOT,
                'packages/extension/resources/tool_use_agents',
              ),
            ),
        },
      },
    );

    // The fake host answers `custom()` from a temp directory of its own, so
    // nothing in this load reaches the global storage view.
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          refresh(),
          GlobalStorageFs,
          {} as RootedFileSystem,
        ).pipe(
          Effect.provideService(AgentDirectories, fakeHostAgentDirectories),
          Effect.provideService(AppState, new FakeStateStore()),
        ),
        Layer.merge(nodePlatformLayer, testHttpClientLayer),
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
        const builtIn = yield* launchAs(getCatalogAgent('builtIn:assistant'));
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
        const unpinned = yield* resolveAgentForLaunch(
          hostStores(),
          'assistant',
        );
        expect(unpinned).toBe(yield* visibleAgent('assistant'));
        expect(unpinned?.source).toBe('custom');

        // A stale/missing pinned source falls through to that same visible-set tier.
        const stale = yield* resolveAgentForLaunch(
          hostStores(),
          'assistant',
          'plugin',
        );
        expect(stale?.source).toBe('custom');

        // A `source:name` key matches its exact entry, even a shadowed one.
        const keyed = yield* resolveAgentForLaunch(
          hostStores(),
          'builtIn:assistant',
        );
        expect(keyed?.source).toBe('builtIn');
      }),
  );

  it.effect('resolves scoped keys and drops unknown ones', () =>
    Effect.gen(function* () {
      const scoped = yield* resolveDelegationScopeAgents(hostStores(), [
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
        const scoped = yield* resolveDelegationScopeAgents(hostStores(), [
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
      task: null,
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
