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

/** A registry model outside the visible list, typed in another case. */
const HIDDEN_MODEL = 'anthropic/claude-haiku-4-5-20251001';

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

const MISSING_KEY_ONLY_ENTRIES: CliModelAccess[] = [
  missingKeyModel('google/gemini-3.1-pro-preview'),
];

const RETIRED_HAIKU3_OPTION = modelOption('anthropic/claude-3-haiku-20240307', {
  label: 'Haiku 3',
  availability: 'retired',
});

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
        fallbackReason: 'environment',
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
        fallbackReason: 'history',
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

  it('reports when no fallback model is runnable', async () => {
    await expect(
      resolveModelFromAccessList(
        MISSING_KEY_ONLY_ENTRIES,
        'google/gemini-3.1-pro-preview',
        {
          fallbackReason: 'command-config',
        },
      ),
    ).rejects.toThrow(
      'Model "google/gemini-3.1-pro-preview" is not available (missing api key). No models are currently available. Add a provider API key with `texra setup`.',
    );
  });

  it('rejects explicit retired hidden models before fallback', async () => {
    readModelOptionsMock.mockReturnValueOnce(
      Effect.succeed([RETIRED_HAIKU3_OPTION]),
    );

    await expect(
      run(
        selectCliRunnableModel(
          [
            {
              model: 'anthropic/claude-3-haiku-20240307',
              reason: 'explicit-override',
            },
          ],
          { accessList: [], stores },
        ),
      ),
    ).rejects.toThrow(
      'Model "anthropic/claude-3-haiku-20240307" is not available (retired).',
    );
  });

  it('ignores stale lower-priority hidden candidates after a runnable winner', async () => {
    readModelOptionsMock.mockReturnValueOnce(Effect.succeed([]));

    await expect(
      run(
        selectCliRunnableModel(
          [
            {
              model: 'anthropic/claude-sonnet-4-6',
              reason: 'explicit-override',
            },
            { model: HIDDEN_MODEL, reason: 'environment' },
          ],
          {
            accessList: [model('anthropic/claude-sonnet-4-6')],
            stores,
          },
        ),
      ),
    ).resolves.toEqual({ model: 'anthropic/claude-sonnet-4-6' });
  });
});
