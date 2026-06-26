// Standard library imports
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import {
  getCategoryAgent,
  getVisibleAgent,
  refresh,
  resolveAgent,
  resolveAgentInCategory,
} from '@agent/index/agentRegistry';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

/**
 * Regression: a custom *workflow* agent named `assistant` collides with the
 * bundled *tool-use* `assistant`. Validation resolves through the category-aware
 * `getVisibleAgent`, but the launch historically re-resolved via the
 * category-blind `getAgent` (source priority: custom > … > builtInToolUse), so
 * it picked the wrong (workflow) entry and the run failed with a category
 * mismatch. The category-scoped resolver keeps validation and launch in lockstep.
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

    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
    setAgentDirectories({
      custom: async () => customDir,
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });

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

  it('resolves an identifier within the requested category at launch', () => {
    const toolUse = resolveAgentInCategory('toolUse', 'assistant');
    expect(toolUse?.entry.category).toBe('toolUse');
    expect(toolUse?.entry.source).toBe('builtInToolUse');

    const workflow = resolveAgentInCategory('workflow', 'assistant');
    expect(workflow?.entry.category).toBe('workflow');
    expect(workflow?.entry.source).toBe('custom');
  });

  it('launch resolution matches validation for the colliding tool-use name', () => {
    const validated = getVisibleAgent('toolUse', 'assistant');
    const launched = resolveAgentInCategory('toolUse', 'assistant');
    expect(launched?.entry.source).toBe(validated?.source);
    expect(launched?.entry.name).toBe(validated?.name);
  });

  it('still resolves a non-colliding name and legacy aliases within category', () => {
    expect(getCategoryAgent('toolUse', 'review')?.name).toBe('review');
    // `chat` is the legacy alias for `assistant`; within tool-use it must map to
    // the built-in tool-use assistant, never the custom workflow shadow.
    expect(getCategoryAgent('toolUse', 'chat')?.source).toBe('builtInToolUse');
    expect(getCategoryAgent('workflow', 'assistant')?.source).toBe('custom');
  });

  it('returns undefined for a name absent from the requested category', () => {
    // `correct` is a workflow agent; it must not resolve as a tool-use launch.
    expect(resolveAgentInCategory('toolUse', 'correct')).toBeUndefined();
  });

  it('hides internal agents from dropdowns but keeps them launchable', () => {
    // Internal agents are excluded from the visible/dropdown set…
    expect(getVisibleAgent('toolUse', 'secretAgent')).toBeUndefined();
    // …but the launch resolver must still reach them (launchable by commands).
    expect(resolveAgentInCategory('toolUse', 'secretAgent')?.entry.name).toBe(
      'secretAgent',
    );
    expect(getCategoryAgent('toolUse', 'secretAgent')?.internal).toBe(true);
  });
});
