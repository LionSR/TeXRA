import { beforeEach, describe, expect, it } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { DocumentTaskSchema } from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';
import { FakeConfigProvider, fakePath } from '@test/support/FakePlatform';

/** The harness runtime supplies the standard-library filesystem prompt
 *  assembly reads through. */
const buildOpening = (...args: Parameters<typeof buildTemplateInputs>) =>
  testRuntime().runPromise(buildTemplateInputs(...args));

// getConfig reads through the platform config provider; drive the setting
// via this provider instead of patching the ESM export.
const fakeConfig = new FakeConfigProvider();

setupPlatform({}, { config: fakeConfig });

// The describes below replace the whole global platform in their own
// beforeEach and never restore it — they MUST stay the last describes in
// this file.
function buildVars(
  agentConfig: ReturnType<typeof AgentConfigSchema.parse>,
  files: Record<string, string> = {},
): ReturnType<typeof buildOpening> {
  return buildOpening(
    agentConfig,
    DocumentTaskSchema.parse({ files, requests: ['Revise.'] }),
    fakePath('agents/generic'),
    false,
    noopTrace,
    {
      workspacePath: fakePath('workspace'),
      storageRoot: testWorkspaceRoots().storage,
    },
  );
}

describe('buildTemplateInputs with missing configured files', () => {
  beforeEach(async () => {
    await installPlatform({
      workspacePath: fakePath('workspace'),
      files: {
        '/workspace/present.tex': 'present input',
        '/workspace/context.tex': 'present context',
        '/workspace/.texra/storage/memories/present.md':
          '---\nmodifiedBy: user\nmodifiedAt: 2026-06-20T14:30:45.123Z\n---\nRemember this convention.',
      },
    });
  });

  it('keeps prompt file metadata in sync with readable prompt XML', async () => {
    const { inputs: vars } = await buildVars(
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
    expect(vars.CONTEXT_FILES).toEqual(['context.tex']);
    expect(vars.LIST_OF_ALL_CONTEXTS).toBe('context.tex');
    expect(vars.CONTEXT_FILE).toBe('context.tex');
    expect(vars.CONTEXT_CONTENT).toBe('present context');
  });

  it('records attached memory read misses from the prompt-load pass', async () => {
    const { inputs: vars, attachedMemoryMisses } = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        memories: ['/memories/present.md', '/memories/missing.md'],
      }),
    );

    expect(vars.ATTACHED_MEMORIES).toBe(
      '<attached_memories>\n<memory name="/memories/present.md">\nRemember this convention.\n</memory>\n</attached_memories>',
    );
    expect(attachedMemoryMisses).toEqual([
      expect.objectContaining({ path: '/memories/missing.md' }),
    ]);
  });
});

describe('task.files custom variables', () => {
  const briefPath = fakePath('agents/generic', 'brief.txt');

  beforeEach(async () => {
    await installPlatform({
      workspacePath: fakePath('workspace'),
      files: { [briefPath]: 'briefing notes' },
    });
  });

  // A required file named after a file category generates the fixed X_FILE /
  // X_CONTENT variables and would silently override them. The guard fails
  // loudly at variable-build time instead.
  it.each(['INPUT', 'CONTEXT', 'EDITED', 'MEDIA'])(
    'rejects a required file named %s whose generated variables collide with the fixed vocabulary',
    async (varName) => {
      await expect(
        buildVars(
          AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
          { [varName]: 'brief.txt' },
        ),
      ).rejects.toThrow('collides with a fixed template variable');
    },
  );

  it('passes custom required-file variables through beside the fixed vocabulary', async () => {
    const { inputs: vars } = await buildVars(
      AgentConfigSchema.parse({ agent: 'generic', model: 'test-model' }),
      { BRIEF: 'brief.txt' },
    );

    expect(vars['BRIEF_FILE']).toBe(briefPath);
    expect(vars['BRIEF_CONTENT']).toBe('briefing notes');
    // The fixed slots the collision guard protects keep their built values.
    expect(vars.MEDIA_FILE).toBeNull();
    expect(vars.INSTRUCTION).toBe('');
  });
});
