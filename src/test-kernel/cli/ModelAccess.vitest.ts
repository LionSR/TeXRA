import { layer } from '@effect/vitest';
import { expect } from 'vitest';
import { Effect } from 'effect';

import { apiKeySecretName } from '@texra-ai/llm';
import { selectCliRunnableModel } from '@cli/runtime/models/modelAccess';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';
import type { RunModelDecisionReason } from '@texra-ai/worldline/host';

/** A model whose key this host lacks; its DeepSeek siblings can run. */
const MISSING_KEY_MODEL = 'anthropic/claude-opus-5-5';

/** The lookup for one fallback reason, over the host's stores with a
 *  DeepSeek key stored. */
const resolveModel = (fallbackReason: RunModelDecisionReason) =>
  Effect.gen(function* () {
    const host = yield* FakeHost;
    yield* host.secrets
      .set(apiKeySecretName('deepseek'), 'sk-test-deepseek-key')
      .pipe(Effect.orDie);
    return yield* selectCliRunnableModel(
      [{ model: MISSING_KEY_MODEL, reason: fallbackReason }],
      { stores: host.roots },
    );
  });

layer(SessionGraph.hosted)('CLI model access resolution', (it) => {
  // A fresh TeXRA host per test (its curated models are the listed rows),
  // as the lookups read its stores and keys.
  it.layer(FakeHost.layer({ app: TEXRA_APP }), { buildPerTest: true })((it) => {
    it.effect('owns fallback behavior by model source', () =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(resolveModel('explicit-override'));
        expect(refused.message).toContain(
          'Model "anthropic/claude-opus-5-5" is not available (missing api key). Available models: deepseek/deepseek-flash, deepseek/deepseek-v4-pro.',
        );
        expect(yield* resolveModel('command-config')).toEqual({
          model: 'deepseek/deepseek-flash',
          notice:
            'Model "anthropic/claude-opus-5-5" is not available (missing api key). Available models: deepseek/deepseek-flash, deepseek/deepseek-v4-pro. Using "deepseek/deepseek-flash" instead.',
        });
        expect(yield* resolveModel('builtin-default')).toEqual({
          model: 'deepseek/deepseek-flash',
        });
      }),
    );
  });
});
