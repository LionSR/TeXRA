// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { it } from '@effect/vitest';
import { afterAll, beforeAll, describe, expect } from 'vitest';

// Local imports
import {
  findAgentByIdentifier,
  getCategoryAgent,
  getVisibleAgent,
  refresh,
  resolveAgentForLaunch,
  resolveDelegationScopeAgents,
} from '@agent/index/agentRegistry';
import type { AgentEntry } from '@agent/index/agentEntry';
import { AgentDirectories } from '@platform/interfaces';
import { GlobalStorageFs } from '@platform/rootedFs';
import { AgentCategory } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  fakeHostAgentDirectories,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

/** Resolve exactly as launch does: through the single launch resolver, by the
 * source the delegation captured at validation time (see `getAgentPath`). */
function launchAs(category: AgentCategory, entry: AgentEntry | undefined) {
  return entry
    ? resolveAgentForLaunch(hostStores(), category, entry.name, entry.source)
    : Effect.succeed(undefined);
}

/**
 * A custom *workflow* agent named `assistant` collides with the bundled
 * *tool-use* `assistant`. Validation resolves through the category-aware
 * `getVisibleAgent`; a category-blind resolver would answer the same name with
 * the custom workflow entry (source priority: custom > … > builtInToolUse) and
 * the run would fail with a category mismatch. Launch therefore carries the
 * validated entry's *source* and resolves the exact `(source, name)` key, so
 * it cannot diverge from what validation accepted.
 */
describe('cross-category agent resolution', () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const customAgents: Record<string, string[]> = {
      'assistant.yaml': [
        'name: assistant',
        'description: Custom workflow agent that shadows a built-in name.',
        'settings:',
        '  agentCategory: workflow',
        'prompts:',
        '  systemPrompt: Custom workflow assistant.',
      ],
      'review.yaml': [
        'name: review',
        'description: Custom tool-use agent that shadows a built-in name.',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: Custom review agent.',
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
          refresh({ includeRemote: false }),
          GlobalStorageFs,
          {} as RootedFileSystem,
        ).pipe(
          Effect.provideService(AgentDirectories, fakeHostAgentDirectories),
        ),
        nodePlatformLayer,
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
        // The tool-use delegation validates via getVisibleAgent and carries the
        // entry's source; launch resolves that exact key — the built-in tool-use
        // entry, never the colliding custom workflow shadow.
        const toolUse = yield* launchAs(
          'toolUse',
          yield* getVisibleAgent(hostStores(), 'toolUse', 'assistant'),
        );
        expect(toolUse?.category).toBe('toolUse');
        expect(toolUse?.source).toBe('builtInToolUse');

        // The same mechanism reaches the custom workflow entry when that is what a
        // workflow delegation validated.
        const workflow = yield* launchAs(
          'workflow',
          yield* getVisibleAgent(hostStores(), 'workflow', 'assistant'),
        );
        expect(workflow?.category).toBe('workflow');
        expect(workflow?.source).toBe('custom');
      }),
  );

  it.effect(
    'resolves an unpinned launch through the same visible set as validation',
    () =>
      Effect.gen(function* () {
        // A direct launch without a pinned source (e.g. the webview "Run") routes
        // through getVisibleAgent — the identical call validation makes — so it
        // resolves to exactly the entry validation would, never a same-name shadow.
        const toolUse = yield* resolveAgentForLaunch(
          hostStores(),
          AgentCategory.ToolUse,
          'assistant',
        );
        expect(toolUse).toBe(
          yield* getVisibleAgent(hostStores(), 'toolUse', 'assistant'),
        );
        expect(toolUse?.source).toBe('builtInToolUse');

        const workflow = yield* resolveAgentForLaunch(
          hostStores(),
          AgentCategory.Workflow,
          'assistant',
        );
        expect(workflow).toBe(
          yield* getVisibleAgent(hostStores(), 'workflow', 'assistant'),
        );

        // A stale/missing pinned source falls through to that same visible-set tier.
        const stale = yield* resolveAgentForLaunch(
          hostStores(),
          AgentCategory.ToolUse,
          'assistant',
          'remote',
        );
        expect(stale?.source).toBe('builtInToolUse');
      }),
  );

  it('resolves a non-colliding name within category', () => {
    expect(getCategoryAgent('toolUse', 'review')?.name).toBe('review');
    expect(getCategoryAgent('workflow', 'assistant')?.source).toBe('custom');
  });

  it('keeps a wrong-category name out of category-scoped resolution', () => {
    // `correct` is a workflow agent and must not resolve as tool-use.
    expect(getCategoryAgent('toolUse', 'correct')).toBeUndefined();
  });

  it.effect(
    'resolves scoped names within category and drops unknown ones',
    () =>
      Effect.gen(function* () {
        const scoped = yield* resolveDelegationScopeAgents(
          hostStores(),
          {
            workflow: [],
            toolUse: ['assistant', 'builtInToolUse:assistant', 'missing-agent'],
          },
          AgentCategory.ToolUse,
        );

        expect(scoped.map((entry) => `${entry.source}:${entry.name}`)).toEqual([
          'builtInToolUse:assistant',
        ]);
      }),
  );

  it.effect(
    'preserves exact source-qualified roster entries before name deduplication',
    () =>
      Effect.gen(function* () {
        // Both source-qualified identifiers must resolve to their own entry
        // (`custom:review` to the custom one, not the built-in it shadows), and
        // the deduplicated result must keep both, in scope order.
        const scoped = yield* resolveDelegationScopeAgents(
          hostStores(),
          {
            workflow: [],
            toolUse: ['builtInToolUse:review', 'custom:review'],
          },
          AgentCategory.ToolUse,
        );

        expect(scoped.map((entry) => `${entry.source}:${entry.name}`)).toEqual([
          'builtInToolUse:review',
          'custom:review',
        ]);
      }),
  );
});

describe('findAgentByIdentifier (shared identity rule)', () => {
  function entry(name: string, source: AgentEntry['source']): AgentEntry {
    return { name, source, path: '', category: AgentCategory.ToolUse };
  }
  const entries = [
    entry('review', 'builtInToolUse'),
    entry('review', 'custom'),
  ];

  it('matches a bare name by name (first candidate wins)', () => {
    expect(findAgentByIdentifier(entries, 'review')?.source).toBe(
      'builtInToolUse',
    );
  });

  it('matches a source-qualified key only by exact key', () => {
    expect(findAgentByIdentifier(entries, 'custom:review')?.source).toBe(
      'custom',
    );
    // A key whose source is absent from the set must not fall back to the name.
    expect(findAgentByIdentifier(entries, 'remote:review')).toBeUndefined();
  });

  it('returns undefined when no candidate matches', () => {
    expect(findAgentByIdentifier(entries, 'missing')).toBeUndefined();
  });
});
