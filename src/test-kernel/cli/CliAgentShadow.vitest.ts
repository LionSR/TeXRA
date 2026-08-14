// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { refresh } from '@agent/index/agentRegistry';
import { chatToolUseAgentUsageError } from '@cli/chat/tui/commands/handlers/agentModelCommands';
import {
  assertCliAgentLaunch,
  chatAgentSupportsDelegation,
  resolveCliAgentInCategory,
} from '@cli/runtime/agents';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { AgentCategory } from '@shared/schemas';
import { REPO_ROOT } from '@test/support/repoScan';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

/**
 * A custom *workflow* agent named `assistant` shadows the bundled *tool-use*
 * `assistant`. CLI validation used to resolve by source priority, which picked
 * the workflow shadow: `texra chat --agent assistant` failed with a category
 * mismatch while the extension launched the tool-use agent, and the delegation
 * probe read `tools` off the shadow. Validation now resolves through the same
 * category-scoped launch resolver the run itself uses.
 */
describe('CLI agent validation with a shadowed name', () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const customDir = await makeTempDir('texra-cli-shadow-', tempDirs);
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

  it('validates the shadowed name against the tool-use entry launch will run', () => {
    const entry = resolveCliAgentInCategory('assistant', AgentCategory.ToolUse);

    expect(entry?.source).toBe('builtInToolUse');
    expect(entry?.category).toBe(AgentCategory.ToolUse);
    expect(assertCliAgentLaunch('assistant', entry, 'chat')).toBe(entry);
    expect(chatToolUseAgentUsageError('assistant')).toBeUndefined();
  });

  it('reads delegation support off the tool-use entry, not the shadow', () => {
    expect(
      resolveCliAgentInCategory('assistant', AgentCategory.Workflow)?.source,
    ).toBe('custom');
    expect(chatAgentSupportsDelegation('assistant')).toBe(true);
  });

  it('still reports the category mismatch for a workflow-only agent', () => {
    expect(
      resolveCliAgentInCategory('polish', AgentCategory.ToolUse),
    ).toBeUndefined();
    expect(chatToolUseAgentUsageError('polish')).toContain(
      'Agent "polish" is a workflow agent; `texra chat` only handles tool-use agents.',
    );
  });

  it('reports an unknown name as missing rather than mismatched', () => {
    expect(chatToolUseAgentUsageError('no-such-agent')).toContain(
      'Tool-use agent not found: no-such-agent.',
    );
  });

  it('resolves a source-qualified identifier to that exact source', () => {
    expect(
      resolveCliAgentInCategory(
        'builtInToolUse:assistant',
        AgentCategory.ToolUse,
      )?.source,
    ).toBe('builtInToolUse');
    // The workflow shadow's own key stays out of the tool-use category.
    expect(
      resolveCliAgentInCategory('custom:assistant', AgentCategory.ToolUse),
    ).toBeUndefined();
  });
});
