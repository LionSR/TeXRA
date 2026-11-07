import { layer } from '@effect/vitest';
import { expect } from 'vitest';

import { Effect, Layer, Schema } from 'effect';
import { AgentConfigSchema } from '@texra-ai/harness/schemas';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { noopTrace } from '@test/support/noopTrace';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';

const buildVars = (agentConfig: typeof AgentConfigSchema.Type) =>
  Effect.flatMap(FakeHost, (host) =>
    buildTemplateInputs(agentConfig, false, noopTrace, {
      workspaceRoot: host.path('workspace'),
      storageRoot: host.roots.storage,
    }),
  );

// A host whose storage holds one of the two memories the run attaches; the
// standard-library filesystem is what prompt assembly reads through.
layer(
  Layer.merge(
    FakeHost.layer({
      files: {
        '/workspace/.texra/storage/memories/present.md':
          '---\nmodifiedBy: user\nmodifiedAt: 2026-06-20T14:30:45.123Z\n---\nRemember this convention.',
      },
    }),
    nodePlatformLayer,
  ),
  { excludeTestServices: true },
)('buildTemplateInputs with a missing attached memory', (it) => {
  // A configured memory that cannot be read is reported, not dropped.
  it.effect(
    'records attached memory read misses from the prompt-load pass',
    () =>
      Effect.gen(function* () {
        const { attachedMemories, attachedMemoryMisses } = yield* buildVars(
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
      }),
  );
});
