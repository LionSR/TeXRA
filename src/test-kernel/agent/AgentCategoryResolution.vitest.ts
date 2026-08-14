// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Local imports
import {
  findAgentByIdentifier,
  getCategoryAgent,
  getRosterAgent,
  getVisibleAgent,
  refresh,
  resolveAgent,
  resolveAgentForLaunch,
  resolveDelegationScopeAgents,
} from '@agent/index/agentRegistry';
import type { AgentEntry } from '@agent/index/agentEntry';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { AgentCategory } from '@shared/schemas';
import { REPO_ROOT } from '@test/support/repoScan';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

/** Resolve exactly as launch does: through the single launch resolver, by the
 * source the delegation captured at validation time (see `getAgentPath`). */
function launchAs(category: AgentCategory, entry: AgentEntry | undefined) {
  return entry
    ? resolveAgentForLaunch(category, entry.name, entry.source)
    : undefined;
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
        fs: nodeFilesystem,
        agentDirectories: {
          custom: async () => customDir,
          builtIn: async () =>
            resolve(REPO_ROOT, 'packages/extension/resources/agents'),
          builtInToolUse: async () =>
            resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
        },
      },
    );

    await refresh({ includeRemote: false });
  });

  afterAll(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('demonstrates the divergence the category-scoped resolver closes', () => {
    // Category-blind resolution picks the custom workflow entry by source
    // priority…
    const categoryBlind = resolveAgent('assistant')?.entry;
    expect(categoryBlind?.source).toBe('custom');
    expect(categoryBlind?.category).toBe('workflow');

    // …while validation correctly resolves the visible tool-use entry.
    expect(getVisibleAgent('toolUse', 'assistant')?.source).toBe(
      'builtInToolUse',
    );
  });

  it('pins launch to the exact (source, name) entry validation captured', () => {
    // The tool-use delegation validates via getVisibleAgent and carries the
    // entry's source; launch resolves that exact key — the built-in tool-use
    // entry, never the colliding custom workflow shadow.
    const toolUse = launchAs(
      'toolUse',
      getVisibleAgent('toolUse', 'assistant'),
    );
    expect(toolUse?.entry.category).toBe('toolUse');
    expect(toolUse?.entry.source).toBe('builtInToolUse');

    // The same mechanism reaches the custom workflow entry when that is what a
    // workflow delegation validated.
    const workflow = launchAs(
      'workflow',
      getVisibleAgent('workflow', 'assistant'),
    );
    expect(workflow?.entry.category).toBe('workflow');
    expect(workflow?.entry.source).toBe('custom');
  });

  it('launch resolution matches validation for the colliding tool-use name', () => {
    const validated = getVisibleAgent('toolUse', 'assistant');
    const launched = launchAs('toolUse', validated);
    expect(launched?.entry.source).toBe(validated?.source);
    expect(launched?.entry.name).toBe(validated?.name);
  });

  it('resolves an unpinned launch through the same visible set as validation', () => {
    // A direct launch without a pinned source (e.g. the webview "Run") routes
    // through getVisibleAgent — the identical call validation makes — so it
    // resolves to exactly the entry validation would, never a same-name shadow.
    const toolUse = resolveAgentForLaunch(AgentCategory.ToolUse, 'assistant');
    expect(toolUse?.entry).toBe(getVisibleAgent('toolUse', 'assistant'));
    expect(toolUse?.entry.source).toBe('builtInToolUse');

    const workflow = resolveAgentForLaunch(AgentCategory.Workflow, 'assistant');
    expect(workflow?.entry).toBe(getVisibleAgent('workflow', 'assistant'));

    // A stale/missing pinned source falls through to that same visible-set tier.
    const stale = resolveAgentForLaunch(
      AgentCategory.ToolUse,
      'assistant',
      'remote',
    );
    expect(stale?.entry.source).toBe('builtInToolUse');
  });

  it('resolves a non-colliding name within category', () => {
    expect(getCategoryAgent('toolUse', 'review')?.name).toBe('review');
    expect(getCategoryAgent('workflow', 'assistant')?.source).toBe('custom');
  });

  it('keeps a wrong-category name out of category-scoped resolution', () => {
    // `correct` is a workflow agent and must not resolve as tool-use.
    expect(getCategoryAgent('toolUse', 'correct')).toBeUndefined();
  });

  it('resolves scoped names within category and drops unknown ones', () => {
    const scoped = resolveDelegationScopeAgents(
      {
        workflow: [],
        toolUse: ['assistant', 'builtInToolUse:assistant', 'missing-agent'],
      },
      AgentCategory.ToolUse,
    );

    expect(scoped.map((entry) => `${entry.source}:${entry.name}`)).toEqual([
      'builtInToolUse:assistant',
    ]);
  });

  it('preserves exact source-qualified roster entries before name deduplication', () => {
    expect(getRosterAgent('toolUse', 'custom:review')?.source).toBe('custom');
    expect(getRosterAgent('toolUse', 'builtInToolUse:review')?.source).toBe(
      'builtInToolUse',
    );

    const scoped = resolveDelegationScopeAgents(
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
  });
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
