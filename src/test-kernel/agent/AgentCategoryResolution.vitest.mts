// Node imports
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

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
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentEntry } from '@agent/index/agentEntry';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

/** Resolve exactly as launch does: through the single launch resolver, by the
 * source the delegation captured at validation time (see `getAgentPath`). */
function launchAs(category: AgentCategory, entry: AgentEntry | undefined) {
  return entry
    ? resolveAgentForLaunch(category, entry.name, entry.source)
    : undefined;
}

/**
 * Regression: a custom *workflow* agent named `assistant` collides with the
 * bundled *tool-use* `assistant`. Validation resolves through the category-aware
 * `getVisibleAgent`, but the launch historically re-resolved via the
 * category-blind `getAgent` (source priority: custom > … > builtInToolUse), so
 * it picked the wrong (workflow) entry and the run failed with a category
 * mismatch. The fix carries the validated entry's *source* to launch, which
 * resolves the exact `(source, name)` key — so launch can never diverge.
 */
describe('cross-category agent resolution', () => {
  beforeAll(async () => {
    const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
    await writeFile(
      resolve(customDir, 'assistant.yaml'),
      [
        'name: assistant',
        'description: Custom workflow agent that shadows a built-in name.',
        'settings:',
        '  agentCategory: workflow',
        'prompts:',
        '  systemPrompt: Custom workflow assistant.',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(customDir, 'secretAgent.yaml'),
      [
        'name: secretAgent',
        'description: Internal tool-use agent hidden from dropdowns.',
        'settings:',
        '  agentCategory: toolUse',
        '  internal: true',
        'prompts:',
        '  systemPrompt: Internal agent.',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(customDir, 'review.yaml'),
      [
        'name: review',
        'description: Custom tool-use agent that shadows a built-in name.',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: Custom review agent.',
        '',
      ].join('\n'),
    );

    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {},
        {
          fs: nodeFilesystem,
          agentDirectories: {
            custom: async () => customDir,
            builtIn: async () =>
              resolve(REPO_ROOT, 'packages/extension/resources/agents'),
            builtInToolUse: async () =>
              resolve(
                REPO_ROOT,
                'packages/extension/resources/tool_use_agents',
              ),
          },
        },
      ),
    );

    await refresh({ includeRemote: false });
  });

  it('demonstrates the divergence the category-scoped resolver closes', () => {
    // Category-blind resolution (the old launch path) picks the custom workflow
    // entry by source priority…
    expect(resolveAgent('assistant')?.entry.source).toBe('custom');
    expect(resolveAgent('assistant')?.entry.category).toBe('workflow');

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

  it('reaches internal agents only via the full-category floor', () => {
    // Internal agents are absent from the visible set (tier 2), so an unpinned
    // launch resolves them through the full-category floor (tier 3) — still
    // launchable by command, without ever shadowing a visible agent.
    expect(getVisibleAgent('toolUse', 'secretAgent')).toBeUndefined();
    expect(
      resolveAgentForLaunch(AgentCategory.ToolUse, 'secretAgent')?.entry.name,
    ).toBe('secretAgent');
  });

  it('still resolves a non-colliding name and legacy aliases within category', () => {
    expect(getCategoryAgent('toolUse', 'review')?.name).toBe('review');
    // `chat` is the legacy alias for `assistant`; within tool-use it must map to
    // the built-in tool-use assistant, never the custom workflow shadow.
    expect(getCategoryAgent('toolUse', 'chat')?.source).toBe('builtInToolUse');
    expect(getCategoryAgent('workflow', 'assistant')?.source).toBe('custom');
  });

  it('keeps a wrong-category name out of category-scoped resolution', () => {
    // `correct` is a workflow agent; getCategoryAgent (used by the legacy-alias
    // migration) must not resolve it as tool-use.
    expect(getCategoryAgent('toolUse', 'correct')).toBeUndefined();
  });

  it('hides internal agents from dropdowns but keeps them launchable by name', () => {
    // Internal agents are excluded from the visible/dropdown set…
    expect(getVisibleAgent('toolUse', 'secretAgent')).toBeUndefined();
    // …but a command launch (no pinned source) still reaches them by name.
    expect(resolveAgent('secretAgent')?.entry.name).toBe('secretAgent');
    expect(getCategoryAgent('toolUse', 'secretAgent')?.internal).toBe(true);
  });

  it('resolves scoped names within category and excludes internal agents', () => {
    const scoped = resolveDelegationScopeAgents(
      {
        workflowAgentKeys: [],
        toolUseAgentKeys: [
          'assistant',
          'builtInToolUse:assistant',
          'secretAgent',
          'missing-agent',
        ],
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
        workflowAgentKeys: [],
        toolUseAgentKeys: ['builtInToolUse:review', 'custom:review'],
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
