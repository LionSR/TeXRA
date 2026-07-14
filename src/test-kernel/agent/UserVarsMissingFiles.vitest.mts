import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';

import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { buildUserVars } from '@agent/utils/userVars';

const providerFlags = {
  isOpenai: false,
  isAnthropic: false,
  isGoogle: false,
};

function buildVars(
  agentConfig: ReturnType<typeof AgentConfigSchema.parse>,
): ReturnType<typeof buildUserVars> {
  const agentSetting = AgentWorkflowSettingSchema.parse({
    agentCategory: AgentCategory.Workflow,
  });
  const agentPrompt = AgentPromptSchema.parse({});
  return buildUserVars(
    agentConfig,
    agentSetting,
    agentPrompt,
    '/agents/generic',
    providerFlags,
    noopTrace,
    { workspacePath: '/workspace' },
  );
}

describe('buildUserVars with missing configured files', () => {
  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');

    initPlatform(
      createFakePlatform({
        workspacePath: '/workspace',
        files: {
          '/workspace/present.tex': 'present input',
          '/workspace/context.tex': 'present context',
          '/workspace/.texra/storage/memories/present.md':
            '---\nmodifiedBy: user\n---\nRemember this convention.',
        },
      }),
    );
  });

  it('keeps prompt file metadata in sync with readable prompt XML', async () => {
    const vars = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        inputFiles: ['missing.tex', 'present.tex'],
        contextFiles: ['missing-context.tex', 'context.tex'],
      }),
    );

    expect(vars.ALL_INPUTS).toBe(
      '<document name="present.tex">\npresent input\n</document>',
    );
    expect(vars.INPUT_FILES).toEqual(['present.tex']);
    expect(vars.LIST_OF_ALL_INPUTS).toBe('present.tex');
    expect(vars.INPUT_FILE).toBe('present.tex');
    expect(vars.INPUT_CONTENT).toBe('present input');

    expect(vars.ALL_CONTEXTS).toBe(
      '<document name="context.tex">\npresent context\n</document>',
    );
    expect(vars.REFERENCE_FILES).toEqual(['context.tex']);
    expect(vars.LIST_OF_ALL_REFERENCES).toBe('context.tex');
    expect(vars.LIST_OF_ALL_CONTEXTS).toBe('context.tex');
    expect(vars.CONTEXT_FILE).toBe('context.tex');
    expect(vars.CONTEXT_CONTENT).toBe('present context');
  });

  it('records attached memory read misses from the prompt-load pass', async () => {
    const vars = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        memories: ['/memories/present.md', '/memories/missing.md'],
      }),
    );

    expect(vars.ATTACHED_MEMORIES).toBe(
      '<attached_memories>\n<memory name="/memories/present.md">\nRemember this convention.\n</memory>\n</attached_memories>',
    );
    expect(vars.ATTACHED_MEMORY_MISSES).toEqual([
      expect.objectContaining({ path: '/memories/missing.md' }),
    ]);
  });
});
