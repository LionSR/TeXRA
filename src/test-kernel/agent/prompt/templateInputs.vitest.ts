import { beforeEach, describe, expect, it } from 'vitest';
import { AgentConfigSchema } from '@shared/schemas';

import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';
import { fakePath } from '@test/support/FakePlatform';

/** The harness runtime supplies the standard-library filesystem prompt
 *  assembly reads through. */
const buildOpening = (...args: Parameters<typeof buildTemplateInputs>) =>
  testRuntime().runPromise(buildTemplateInputs(...args));

setupPlatform();

// The describes below replace the whole global platform in their own
// beforeEach and never restore it — they MUST stay the last describes in
// this file.
function buildVars(
  agentConfig: ReturnType<typeof AgentConfigSchema.parse>,
): ReturnType<typeof buildOpening> {
  return buildOpening(agentConfig, false, noopTrace, {
    workspacePath: fakePath('workspace'),
    storageRoot: testWorkspaceRoots().storage,
  });
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
    const { attachedMemories, attachedMemoryMisses } = await buildVars(
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'test-model',
        memories: ['/memories/present.md', '/memories/missing.md'],
      }),
    );

    expect(attachedMemories).toBe(
      '<attached_memories>\n<memory name="/memories/present.md">\nRemember this convention.\n</memory>\n</attached_memories>',
    );
    expect(attachedMemoryMisses).toEqual([
      expect.objectContaining({ path: '/memories/missing.md' }),
    ]);
  });
});
