import { layer } from '@effect/vitest';
import { beforeEach, expect, vi } from 'vitest';
import { Effect } from 'effect';

import {
  selectCliRunnableModel,
  type CliModelAccess,
} from '@cli/runtime/models/modelAccess';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import type { RunModelDecisionReason } from '@texra-ai/harness/host';

const readModelOptionsMock = vi.hoisted(() => vi.fn());

vi.mock('@model/computeModelOptions', () => ({
  // A case seeds the option rows on the read, and the wording below hands
  // them straight back.
  readModelOptions: readModelOptionsMock,
}));
// The availability read is stubbed to rows already.
vi.mock('@texra/model/modelOptions', () => ({
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
}));

function model(
  value: string,
  overrides: Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: { value, label: value },
    available: true,
    status: 'available',
    ...overrides,
  };
}

function modelOption(
  value: string,
  overrides: Partial<ModelOptionData> = {},
): ModelOptionData {
  return {
    value,
    label: value,
    ...overrides,
  };
}

function missingKeyModel(value: string): CliModelAccess {
  return model(value, {
    available: false,
    status: 'missing api key',
    model: modelOption(value, {
      availability: 'missing-key',
    }),
  });
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
  accessList: readonly CliModelAccess[],
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
    beforeEach(() => {
      readModelOptionsMock.mockReset();
    });

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
