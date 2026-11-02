// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, vi } from 'vitest';

// Local imports
import { apiKeyEnvName } from '@texra-ai/llm';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { FakeHost } from '@test/support/testKernel';
import { ProbeEnvironmentTool } from '@texra/tools/setup/ProbeEnvironmentTool';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

const mocks = vi.hoisted(() => ({
  locateTool:
    vi.fn<
      (
        name: string,
      ) => Effect.Effect<
        { name: string; installed: boolean; path?: string },
        unknown
      >
    >(),
}));

vi.mock('@texra/tools/setup/toolProbing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@texra/tools/setup/toolProbing')>()),
  locateTool: mocks.locateTool,
}));

function outputOf(result: { output?: string }): string {
  return result.output ?? '';
}

/** A host whose environment holds a provider key. */
const host = FakeHost.layer(
  { env: { [apiKeyEnvName('deepseek')]: 'private-test-value' } },
  { setup: createFakeSetupPlatform() },
);

beforeEach(() => {
  // The default fake host has no credentials at all, so the aggregate probe
  // answers false without any stubbing; each test seeds what it needs.
  mocks.locateTool.mockReset().mockImplementation((name) =>
    Effect.succeed({
      name,
      installed: true,
      path: '/test/tool',
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

layer(host, { buildPerTest: true })('setup credential reporting', (it) => {
  it.effect(
    'reports the active host and provider-key origin without secret values',
    () =>
      Effect.gen(function* () {
        const result = yield* ProbeEnvironmentTool.call({}).pipe(
          Effect.provide(withSetup(nativeToolTestLayer(), 'cli')),
        );

        assert.match(outputOf(result), /"host": "cli"/);
        assert.match(outputOf(result), /"provider": "deepseek"/);
        assert.match(outputOf(result), /"origin": "env"/);
        assert.doesNotMatch(outputOf(result), /private-test-value/);
      }),
  );
});
