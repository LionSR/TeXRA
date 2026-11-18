import { layer } from '@effect/vitest';
import { expect } from 'vitest';
import { Effect } from 'effect';

import { selectCliRunnableModel } from '@cli/runtime/models/modelAccess';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import type { RunModelDecisionReason } from '@texra-ai/harness/host';

function model(value: string): ModelOptionData {
  return { value, label: value };
}

function missingKeyModel(value: string): ModelOptionData {
  return { value, label: value, availability: 'missing-key' };
}

/**
 * The process stores every access lookup reads, threaded in by the caller the
 * way the CLI composition root threads its own: the fake settings stores and
 * a runtime over the block's graph.
 */
const stores = Effect.map(SessionGraph.runtime, (runtime) => ({
  ...makeFakeSettingsStores().stores,
  runtime,
}));

/** The lookup for one fallback reason, over the process stores. */
const resolveModelFromAccessList = (
  accessList: readonly ModelOptionData[],
  model: string,
  { fallbackReason }: { readonly fallbackReason: RunModelDecisionReason },
) =>
  Effect.flatMap(stores, (processStores) =>
    selectCliRunnableModel([{ model, reason: fallbackReason }], {
      accessList,
      stores: processStores,
    }),
  );

layer(SessionGraph.hosted)('CLI model access resolution', (it) => {
  // A fresh default host per test, as the lookups read its stores.
  it.layer(FakeHost.layer({}), { buildPerTest: true })((it) => {
    it.effect('owns fallback behavior by model source', () =>
      Effect.gen(function* () {
        const entries = [
          missingKeyModel('missingModel'),
          model('deepseek/deepseek-v4-flash'),
        ];

        const refused = yield* Effect.flip(
          resolveModelFromAccessList(entries, 'missingModel', {
            fallbackReason: 'explicit-override',
          }),
        );
        expect(refused.message).toContain(
          'Model "missingModel" is not available (missing api key). Available models: deepseek/deepseek-v4-flash.',
        );
        expect(
          yield* resolveModelFromAccessList(entries, 'missingModel', {
            fallbackReason: 'command-config',
          }),
        ).toEqual({
          model: 'deepseek/deepseek-v4-flash',
          notice:
            'Model "missingModel" is not available (missing api key). Available models: deepseek/deepseek-v4-flash. Using "deepseek/deepseek-v4-flash" instead.',
        });
        expect(
          yield* resolveModelFromAccessList(entries, 'missingModel', {
            fallbackReason: 'builtin-default',
          }),
        ).toEqual({ model: 'deepseek/deepseek-v4-flash' });
      }),
    );
  });
});
