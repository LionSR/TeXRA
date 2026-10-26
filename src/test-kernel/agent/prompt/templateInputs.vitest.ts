import { beforeEach, describe, expect, it } from 'vitest';

import { Schema } from 'effect';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { AgentConfigSchema } from '@shared/schemas';
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
  agentConfig: typeof AgentConfigSchema.Type,
): ReturnType<typeof buildOpening> {
  return buildOpening(agentConfig, false, noopTrace, {
    workspacePath: fakePath('workspace'),
    storageRoot: testWorkspaceRoots().storage,
  });
}

describe('buildTemplateInputs with a missing attached memory', () => {
  beforeEach(async () => {
    await installPlatform({
      workspacePath: fakePath('workspace'),
      files: {
        '/workspace/.texra/storage/memories/present.md':
          '---\nmodifiedBy: user\nmodifiedAt: 2026-06-20T14:30:45.123Z\n---\nRemember this convention.',
      },
    });
  });

  // A configured memory that cannot be read is reported, not dropped.
  it('records attached memory read misses from the prompt-load pass', async () => {
    const { attachedMemories, attachedMemoryMisses } = await buildVars(
      Schema.decodeUnknownSync(AgentConfigSchema)({
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
