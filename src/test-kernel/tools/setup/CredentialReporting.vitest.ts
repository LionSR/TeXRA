// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';

// Local imports
import { apiKeyEnvName } from '@texra-ai/llm';
import { outputOf } from '@test/support/toolResultFields';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { withEnv } from '@test/support/testEnv';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { ProbeEnvironmentTool } from '@texra/tools/setup/ProbeEnvironmentTool';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

/** The process environment a case runs under: it holds a provider key. */
const ENV = { [apiKeyEnvName('deepseek')]: 'private-test-value' };

/** A host of the test's own. */
const host = FakeHost.layer();

layer(SessionGraph.hosted)('setup credential reporting', (it) => {
  it.layer(host, { buildPerTest: true })((it) => {
    it.effect(
      'reports the active host and provider-key origin without secret values',
      () =>
        Effect.gen(function* () {
          const result = yield* ProbeEnvironmentTool.call({}).pipe(
            Effect.provide(
              withSetup(
                nativeToolTestLayer(),
                createFakeSetupPlatform(),
                'cli',
              ),
            ),
          );

          assert.match(outputOf(result) ?? '', /"host": "cli"/);
          assert.match(outputOf(result) ?? '', /"provider": "deepseek"/);
          assert.match(outputOf(result) ?? '', /"origin": "env"/);
          assert.doesNotMatch(outputOf(result) ?? '', /private-test-value/);
        }).pipe(withEnv(ENV)),
    );
  });
});
