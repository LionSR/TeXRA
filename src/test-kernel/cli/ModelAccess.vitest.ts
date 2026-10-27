import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import {
  selectCliRunnableModel,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import type { ProcessServices } from '@platform/processRuntime';
import type { ModelOptionData } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { setupPlatform } from '@test/support/setupPlatform';
import type { RunModelDecisionReason } from '@texra-ai/harness';

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

setupPlatform({});

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
 * way the CLI composition root threads its own.
 */
const fake = makeFakeSettingsStores();
const stores = {
  ...fake.stores,
  secrets: fake.secrets,
  // Read when a lookup runs: the kernel builds its runtime after collection.
  get runtime() {
    return testRuntime();
  },
};

/**
 * Model access returns Effects; this suite is their run boundary, the same
 * way a citty command action or the Ink form load is in production.
 */
function run<A, E>(effect: Effect.Effect<A, E, ProcessServices>): Promise<A> {
  return stores.runtime.runPromise(effect);
}

function resolveModelFromAccessList(
  accessList: readonly CliModelAccess[],
  model: string,
  { fallbackReason }: { readonly fallbackReason: RunModelDecisionReason },
) {
  return run(
    selectCliRunnableModel([{ model, reason: fallbackReason }], {
      accessList,
      stores,
    }),
  );
}

describe('CLI model access resolution', () => {
  beforeEach(() => {
    readModelOptionsMock.mockReset();
  });

  it('owns fallback behavior by model source', async () => {
    const entries = [
      missingKeyModel('missingModel'),
      model('deepseek/deepseek-v4-flash'),
    ];

    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'explicit-override',
      }),
    ).rejects.toThrow(
      'Model "missingModel" is not available (missing api key). Available models: deepseek/deepseek-v4-flash.',
    );
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'command-config',
      }),
    ).resolves.toEqual({
      model: 'deepseek/deepseek-v4-flash',
      notice:
        'Model "missingModel" is not available (missing api key). Available models: deepseek/deepseek-v4-flash. Using "deepseek/deepseek-v4-flash" instead.',
    });
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'builtin-default',
      }),
    ).resolves.toEqual({ model: 'deepseek/deepseek-v4-flash' });
  });
});
