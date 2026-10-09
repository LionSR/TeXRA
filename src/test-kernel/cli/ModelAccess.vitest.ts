import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';

import {
  formatCliModelDetails,
  getCliModelAccessList,
  modelSelectItemsForCli,
  loadCliModelAccessEntry,
  selectCliRunnableModel,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import type { ProcessServices } from '@platform/processRuntime';
import type { ModelOptionData } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { fakeStores } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';

const readModelAvailabilityInputsMock = vi.hoisted(() => vi.fn());

vi.mock('@model/computeModelOptions', () => ({
  readModelAvailabilityInputs: readModelAvailabilityInputsMock,
  // Availability is read once and finished purely, so a case seeds the option
  // rows on the read and the pure finisher hands them straight back.
  usageRouteFrom: () => undefined,
}));
// The availability read is stubbed to rows already.
vi.mock('@texra/model/modelOptions', () => ({
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
}));

/** A registry model outside the visible list, typed in another case. */
const HIDDEN_MODEL = 'anthropic/claude-haiku-4-5-20251001';
/** A registry model reached by its API id (`grok-4.7`) or label. */
const USER_FACING_MODEL = 'xai/grok-4.7';

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

type ResolveCliRunnableModelOptions = Parameters<
  typeof selectCliRunnableModel
>[1];

/**
 * The process stores every access lookup reads, threaded in by the caller the
 * way the CLI composition root threads its own.
 */
const stores = { ...fakeStores(), runtime: testRuntime() };

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
  options: Omit<ResolveCliRunnableModelOptions, 'accessList' | 'stores'>,
) {
  return run(selectCliRunnableModel(model, { ...options, accessList, stores }));
}

const MISSING_KEY_ONLY_ENTRIES: CliModelAccess[] = [
  missingKeyModel('google/gemini-3.1-pro-preview'),
];

const RETIRED_HAIKU3_OPTION = modelOption('anthropic/claude-3-haiku-20240307', {
  label: 'Haiku 3',
  availability: 'retired',
});

function expectModelOptionsRequested(models: string[]): void {
  expect(readModelAvailabilityInputsMock).toHaveBeenCalledWith(stores, models);
}

describe('CLI model access resolution', () => {
  beforeEach(() => {
    readModelAvailabilityInputsMock.mockReset();
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

  effectIt.effect(
    'builds model picker rows from the access-list source of truth',
    () =>
      Effect.gen(function* () {
        const rows = yield* modelSelectItemsForCli([
          model('deepseek/deepseek-v4-flash', {
            model: modelOption('deepseek/deepseek-v4-flash', {
              label: 'DeepSeek',
              reasoning: 'Default (High)',
              availability: 'provider-key',
            }),
            status: 'api key set',
          }),
          model('openrouterOnlyT', {
            model: modelOption('openrouterOnlyT', {
              label: 'OpenRouter Only',
              availability: 'openrouter-key',
            }),
            status: 'openrouter key',
          }),
          model('google/gemini-3.1-pro-preview', {
            available: false,
            model: modelOption('google/gemini-3.1-pro-preview', {
              label: 'Gemini',
              availability: 'missing-key',
            }),
            status: 'missing api key',
          }),
        ]);

        expect(rows.map((row) => row.value)).toEqual([
          'deepseek/deepseek-v4-flash',
          'openrouterOnlyT',
        ]);
        expect(rows.map((row) => row.description)).toEqual([
          'api: api key set · reasoning setting: Default (High)',
          'api: openrouter key',
        ]);
      }),
  );

  effectIt.effect(
    'marks runnable model picker rows disabled when a live chat cannot switch formats',
    () =>
      Effect.gen(function* () {
        expect(
          yield* modelSelectItemsForCli(
            [
              model('anthropic/claude-sonnet-4-6', {
                model: modelOption('anthropic/claude-sonnet-4-6', {
                  label: 'Sonnet',
                  reasoning: 'Low',
                  availability: 'provider-key',
                }),
                status: 'api key set',
              }),
              model('openai/gpt-5.5-2026-04-23', {
                model: modelOption('openai/gpt-5.5-2026-04-23', {
                  label: 'GPT-5.5',
                  availability: 'provider-key',
                }),
                status: 'api key set',
              }),
            ],
            (candidate) =>
              Effect.succeed(
                candidate === 'anthropic/claude-sonnet-4-6'
                  ? 'different conversation format; start new chat'
                  : undefined,
              ),
          ),
        ).toEqual([
          {
            value: 'anthropic/claude-sonnet-4-6',
            label: 'Sonnet',
            description:
              'different conversation format; start new chat; api: api key set · reasoning setting: Low',
            disabled: true,
          },
          {
            value: 'openai/gpt-5.5-2026-04-23',
            label: 'GPT-5.5',
            description: 'api: api key set',
            disabled: false,
          },
        ]);
      }),
  );

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
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([RETIRED_HAIKU3_OPTION]),
    );

    await expect(
      run(
        selectCliRunnableModel('anthropic/claude-3-haiku-20240307', {
          fallbackReason: 'explicit-override',
          accessList: [],
          stores,
        }),
      ),
    ).rejects.toThrow(
      'Model "anthropic/claude-3-haiku-20240307" is not available (retired).',
    );
  });

  it.each([
    {
      name: 'shows terminal recovery text for retired models in model details',
      entry: model('anthropic/claude-3-haiku-20240307', {
        available: false,
        status: 'retired',
        model: modelOption('anthropic/claude-3-haiku-20240307', {
          label: 'Haiku 3',
          availability: 'retired',
        }),
      }),
      contains: [
        'status: retired',
        'availability: Retired',
        'recovery: Choose an active model.',
      ],
      excludes: ['texra setup'],
    },
    {
      name: 'shows a recovery hint for missing provider-key models in model details',
      entry: model('glm/glm-5.2', {
        available: false,
        status: 'missing api key',
        model: modelOption('glm/glm-5.2', {
          label: 'GLM-5.2',
          availability: 'missing-key',
        }),
      }),
      contains: [
        'status: missing api key',
        'recovery: Add a provider API key with `texra setup`.',
      ],
      excludes: [],
    },
  ])('$name', ({ entry, contains, excludes }) => {
    const text = formatCliModelDetails(entry);

    for (const expected of contains) expect(text).toContain(expected);
    for (const absent of excludes) expect(text).not.toContain(absent);
  });

  it('keeps ChatGPT models available without TeXRA sign-in or API keys', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption('openai/gpt-5.6-sol', {
          availability: 'subscription-access',
        }),
      ]),
    );

    await expect(run(getCliModelAccessList({ stores }))).resolves.toMatchObject(
      [
        {
          available: true,
          model: {
            value: 'openai/gpt-5.6-sol',
            availability: 'subscription-access',
          },
        },
      ],
    );
  });

  it('checks access for explicit models hidden from the visible model list', async () => {
    readModelAvailabilityInputsMock
      .mockReturnValueOnce(
        Effect.succeed([
          modelOption('anthropic/claude-sonnet-4-6', {
            availability: 'provider-key',
          }),
        ]),
      )
      .mockReturnValueOnce(
        Effect.succeed([
          modelOption(HIDDEN_MODEL, { availability: 'provider-key' }),
        ]),
      );

    await expect(
      run(
        selectCliRunnableModel(HIDDEN_MODEL.toUpperCase(), {
          fallbackReason: 'explicit-override',
          stores,
        }),
      ),
    ).resolves.toEqual({ model: HIDDEN_MODEL });
    expect(readModelAvailabilityInputsMock).toHaveBeenNthCalledWith(2, stores, [
      HIDDEN_MODEL,
    ]);
  });

  it('ignores stale lower-priority hidden candidates after a runnable winner', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(Effect.succeed([]));

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

  it('resolves hidden model entries for diagnostic commands', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption(HIDDEN_MODEL, {
          availability: 'missing-key',
        }),
      ]),
    );

    await expect(
      run(
        loadCliModelAccessEntry(HIDDEN_MODEL.toUpperCase(), {
          accessList: [model('anthropic/claude-sonnet-4-6')],
          stores,
        }),
      ),
    ).resolves.toMatchObject({
      available: false,
      status: 'missing api key',
      model: {
        value: HIDDEN_MODEL,
        availability: 'missing-key',
      },
    });
    expectModelOptionsRequested([HIDDEN_MODEL]);
  });

  it('resolves user-facing model names to canonical registry ids', async () => {
    await expect(
      resolveModelFromAccessList([model(USER_FACING_MODEL)], 'grok-4.7', {
        fallbackReason: 'explicit-override',
      }),
    ).resolves.toEqual({ model: USER_FACING_MODEL });

    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption(USER_FACING_MODEL, {
          availability: 'missing-key',
        }),
      ]),
    );

    await expect(
      run(
        loadCliModelAccessEntry('Grok 4.7', {
          accessList: [model('anthropic/claude-sonnet-4-6')],
          stores,
        }),
      ),
    ).resolves.toMatchObject({
      available: false,
      model: {
        value: USER_FACING_MODEL,
        availability: 'missing-key',
      },
    });
    expectModelOptionsRequested([USER_FACING_MODEL]);
  });

  it('reports stale hidden model configuration directly', async () => {
    readModelAvailabilityInputsMock
      .mockReturnValueOnce(
        Effect.succeed([
          modelOption('anthropic/claude-sonnet-4-6', {
            availability: 'provider-key',
          }),
        ]),
      )
      .mockReturnValueOnce(Effect.succeed([]));

    await expect(
      run(
        selectCliRunnableModel(HIDDEN_MODEL, {
          fallbackReason: 'explicit-override',
          stores,
        }),
      ),
    ).rejects.toThrow(
      `Model "${HIDDEN_MODEL}" is configured but has no option data.`,
    );
  });
});
