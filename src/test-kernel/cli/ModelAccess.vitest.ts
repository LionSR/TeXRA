import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';

import {
  findCliModelAccessEntry,
  formatCliModelDetails,
  formatCliNoAvailableModelsRecovery,
  formatCliNoRunnableModelsMessage,
  formatModelStatusForCli,
  getCliModelAccessList,
  modelSelectItemsForCli,
  runnableCliModelAccessEntries,
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
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
  usageRouteFrom: () => undefined,
}));

vi.mock('llm-zoo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('llm-zoo')>();
  return {
    ...actual,
    MODEL_CONFIGS: {
      ...actual.MODEL_CONFIGS,
      hiddenFixtureModel: {},
      userFacingFixture: {
        fullName: 'user-facing-fixture',
        label: 'User Facing Fixture',
      },
    },
  };
});

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

const INTERACTIVE_RECOVERY = {
  configureKeyAction: 'configure a provider API key',
} as const;

const MISSING_KEY_ONLY_ENTRIES: CliModelAccess[] = [
  missingKeyModel('gemini31p'),
];

const RETIRED_HAIKU3_OPTION = modelOption('haiku3', {
  label: 'Haiku 3',
  availability: 'retired',
});

const GLM52_MISSING_KEY_ENTRY = model('glm52', {
  available: false,
  status: 'missing api key',
  model: modelOption('glm52', {
    label: 'GLM-5.2',
    availability: 'missing-key',
  }),
});

function expectModelOptionsRequested(models: string[]): void {
  expect(readModelAvailabilityInputsMock).toHaveBeenCalledWith(stores, models);
}

describe('CLI model access resolution', () => {
  beforeEach(() => {
    readModelAvailabilityInputsMock.mockReset();
  });

  it('keeps the requested model when it is currently runnable', async () => {
    await expect(
      resolveModelFromAccessList(
        [model('sonnet46T'), model('opus48T')],
        'opus48T',
        { fallbackReason: 'explicit-override' },
      ),
    ).resolves.toEqual({ model: 'opus48T' });
  });

  it('owns fallback behavior by model source', async () => {
    const entries = [missingKeyModel('missingModel'), model('deepseekT')];

    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'explicit-override',
      }),
    ).rejects.toThrow(
      'Model "missingModel" is not available (missing api key). Available models: deepseekT.',
    );
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'environment',
      }),
    ).rejects.toThrow(
      'Model "missingModel" is not available (missing api key). Available models: deepseekT.',
    );
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'command-config',
      }),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "missingModel" is not available (missing api key). Available models: deepseekT. Using "deepseekT" instead.',
    });
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'history',
      }),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "missingModel" is not available (missing api key). Available models: deepseekT. Using "deepseekT" instead.',
    });
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'builtin-default',
      }),
    ).resolves.toEqual({ model: 'deepseekT' });
  });

  it('filters runnable models by access-list availability', () => {
    const entries = [
      model('sonnet46T', {
        model: modelOption('sonnet46T', {
          availability: 'provider-key',
        }),
      }),
      model('deepseekT', {
        available: false,
        model: modelOption('deepseekT', {
          availability: 'provider-key',
        }),
      }),
      model('openrouterOnlyT', {
        available: false,
        model: modelOption('openrouterOnlyT', {
          availability: 'openrouter-key',
        }),
      }),
      model('gemini31p', {
        available: false,
        model: modelOption('gemini31p', {
          availability: 'missing-key',
        }),
      }),
    ];

    expect(
      runnableCliModelAccessEntries(entries).map((entry) => entry.model.value),
    ).toEqual(['sonnet46T']);
  });

  it('finds model access entries by id case-insensitively', () => {
    const entries = [model('sonnet46T'), model('deepseekT')];

    expect(findCliModelAccessEntry(entries, 'DEEPSEEKT')?.model.value).toBe(
      'deepseekT',
    );
    expect(findCliModelAccessEntry(entries, 'missing')).toBeUndefined();
  });

  const DEEPSEEK_PROVIDER_KEY_ENTRY = model('deepseekT', {
    model: modelOption('deepseekT', { availability: 'provider-key' }),
    status: 'api key set',
  });

  it.each([
    {
      name: 'prefixes a provider-key status with the api label',
      entry: DEEPSEEK_PROVIDER_KEY_ENTRY,
      expected: 'api: api key set',
    },
    {
      name: 'names the GLM Coding Plan when the picker says it pays',
      entry: model('glm52', {
        model: modelOption('glm52', {
          availability: 'provider-key',
          provider: 'glm',
        }),
        status: 'api key set',
        usageRoute: 'glm-coding-plan-subscription',
      }),
      expected: 'api: GLM Coding Plan',
    },
  ])('formats model picker status: $name', ({ entry, expected }) => {
    expect(formatModelStatusForCli(entry)).toBe(expected);
  });

  effectIt.effect(
    'builds model picker rows from the access-list source of truth',
    () =>
      Effect.gen(function* () {
        const rows = yield* modelSelectItemsForCli([
          model('deepseekT', {
            model: modelOption('deepseekT', {
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
          model('gemini31p', {
            available: false,
            model: modelOption('gemini31p', {
              label: 'Gemini',
              availability: 'missing-key',
            }),
            status: 'missing api key',
          }),
        ]);

        expect(rows.map((row) => row.value)).toEqual([
          'deepseekT',
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
              model('sonnet46T', {
                model: modelOption('sonnet46T', {
                  label: 'Sonnet',
                  reasoning: 'Low',
                  availability: 'provider-key',
                }),
                status: 'api key set',
              }),
              model('gpt55', {
                model: modelOption('gpt55', {
                  label: 'GPT-5.5',
                  availability: 'provider-key',
                }),
                status: 'api key set',
              }),
            ],
            (candidate) =>
              Effect.succeed(
                candidate === 'sonnet46T'
                  ? 'different conversation format; start new chat'
                  : undefined,
              ),
          ),
        ).toEqual([
          {
            value: 'sonnet46T',
            label: 'Sonnet',
            description:
              'different conversation format; start new chat; api: api key set · reasoning setting: Low',
            disabled: true,
          },
          {
            value: 'gpt55',
            label: 'GPT-5.5',
            description: 'api: api key set',
            disabled: false,
          },
        ]);
      }),
  );

  effectIt.effect(
    'treats filtered-empty model picker rows as non-actionable',
    () =>
      Effect.gen(function* () {
        expect(
          yield* modelSelectItemsForCli([
            model('deepseekT', {
              available: false,
              model: modelOption('deepseekT', {
                availability: 'provider-key',
              }),
              status: 'api key set',
            }),
            model('gemini31p', {
              available: false,
              model: modelOption('gemini31p', {
                availability: 'missing-key',
              }),
              status: 'missing api key',
            }),
            missingKeyModel('opus48T'),
          ]),
        ).toEqual([]);
      }),
  );

  it('keeps defaults for omitted and nullish recovery actions', () => {
    expect(formatCliNoAvailableModelsRecovery()).toBe(
      'Add a provider API key with `texra setup`.',
    );

    const runtimeNullishActions = { configureKeyAction: null };
    expect(
      // @ts-expect-error JavaScript callers can supply null at this boundary.
      formatCliNoAvailableModelsRecovery(runtimeNullishActions),
    ).toBe('Add a provider API key with `texra setup`.');
    expect(
      // @ts-expect-error JavaScript callers can supply null at this boundary.
      formatCliNoRunnableModelsMessage(runtimeNullishActions),
    ).toBe(
      'No models are available. Add a provider API key with `texra setup`.',
    );
  });

  it('reports when no fallback model is runnable', async () => {
    await expect(
      resolveModelFromAccessList(MISSING_KEY_ONLY_ENTRIES, 'gemini31p', {
        fallbackReason: 'command-config',
      }),
    ).rejects.toThrow(
      'Model "gemini31p" is not available (missing api key). No models are currently available. Add a provider API key with `texra setup`.',
    );
  });

  it('can format command-specific recovery hints for interactive chat', async () => {
    await expect(
      resolveModelFromAccessList(MISSING_KEY_ONLY_ENTRIES, 'gemini31p', {
        fallbackReason: 'command-config',
        noAvailableModelsMessage: 'Run /key to add a provider API key.',
      }),
    ).rejects.toThrow(
      'Model "gemini31p" is not available (missing api key). No models are currently available. Run /key to add a provider API key.',
    );
  });

  it('rejects explicit retired hidden models before fallback', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([RETIRED_HAIKU3_OPTION]),
    );

    await expect(
      run(
        selectCliRunnableModel('haiku3', {
          fallbackReason: 'explicit-override',
          accessList: [],
          stores,
        }),
      ),
    ).rejects.toThrow('Model "haiku3" is not available (retired).');
  });

  it.each([
    {
      name: 'shows terminal recovery text for retired models in model details',
      entry: model('haiku3', {
        available: false,
        status: 'retired',
        model: modelOption('haiku3', {
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
      entry: GLM52_MISSING_KEY_ENTRY,
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
        modelOption('gpt56', {
          availability: 'subscription-access',
        }),
      ]),
    );

    await expect(run(getCliModelAccessList({ stores }))).resolves.toMatchObject(
      [
        {
          available: true,
          model: {
            value: 'gpt56',
            availability: 'subscription-access',
          },
        },
      ],
    );
  });

  it('loads explicit model ids for diagnostic lists', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption('hiddenFixtureModel', {
          availability: 'missing-key',
        }),
      ]),
    );

    await expect(
      run(getCliModelAccessList({ stores, models: ['hiddenFixtureModel'] })),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'missing api key',
        model: {
          value: 'hiddenFixtureModel',
          availability: 'missing-key',
        },
      },
    ]);
    expectModelOptionsRequested(['hiddenFixtureModel']);
  });

  it('uses the loaded access list as the availability source of truth', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption('sonnet46T', {
          availability: 'provider-key',
        }),
        modelOption('deepseekT', {
          availability: 'missing-key',
        }),
      ]),
    );

    const entries = await run(getCliModelAccessList({ stores }));

    expect(entries).toMatchObject([
      { model: { value: 'sonnet46T' }, available: true },
      { model: { value: 'deepseekT' }, available: false },
    ]);
    expect(
      runnableCliModelAccessEntries(entries).map((entry) => entry.model.value),
    ).toEqual(['sonnet46T']);
  });

  it('checks access for explicit models hidden from the visible model list', async () => {
    readModelAvailabilityInputsMock
      .mockReturnValueOnce(
        Effect.succeed([
          modelOption('sonnet46T', { availability: 'provider-key' }),
        ]),
      )
      .mockReturnValueOnce(
        Effect.succeed([
          modelOption('hiddenFixtureModel', { availability: 'provider-key' }),
        ]),
      );

    await expect(
      run(
        selectCliRunnableModel('HIDDENFIXTUREMODEL', {
          fallbackReason: 'explicit-override',
          stores,
        }),
      ),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expect(readModelAvailabilityInputsMock).toHaveBeenNthCalledWith(2, stores, [
      'hiddenFixtureModel',
    ]);
  });

  it('checks hidden model access against a supplied visible model list', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption('hiddenFixtureModel', {
          availability: 'provider-key',
        }),
      ]),
    );

    await expect(
      run(
        selectCliRunnableModel('hiddenFixtureModel', {
          fallbackReason: 'explicit-override',
          accessList: [missingKeyModel('deepseekT')],
          stores,
        }),
      ),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expectModelOptionsRequested(['hiddenFixtureModel']);
  });

  it('ignores stale lower-priority hidden candidates after a runnable winner', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(Effect.succeed([]));

    await expect(
      run(
        selectCliRunnableModel(
          [
            { model: 'sonnet46T', reason: 'explicit-override' },
            { model: 'hiddenFixtureModel', reason: 'environment' },
          ],
          {
            accessList: [model('sonnet46T')],
            stores,
          },
        ),
      ),
    ).resolves.toEqual({ model: 'sonnet46T' });
  });

  it('resolves hidden model entries for diagnostic commands', async () => {
    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption('hiddenFixtureModel', {
          availability: 'missing-key',
        }),
      ]),
    );

    await expect(
      run(
        loadCliModelAccessEntry('HIDDENFIXTUREMODEL', {
          accessList: [model('sonnet46T')],
          stores,
        }),
      ),
    ).resolves.toMatchObject({
      available: false,
      status: 'missing api key',
      model: {
        value: 'hiddenFixtureModel',
        availability: 'missing-key',
      },
    });
    expectModelOptionsRequested(['hiddenFixtureModel']);
  });

  it('resolves user-facing model names to canonical registry ids', async () => {
    await expect(
      resolveModelFromAccessList(
        [model('userFacingFixture')],
        'user-facing-fixture',
        { fallbackReason: 'explicit-override' },
      ),
    ).resolves.toEqual({ model: 'userFacingFixture' });

    readModelAvailabilityInputsMock.mockReturnValueOnce(
      Effect.succeed([
        modelOption('userFacingFixture', {
          availability: 'missing-key',
        }),
      ]),
    );

    await expect(
      run(
        loadCliModelAccessEntry('User Facing Fixture', {
          accessList: [model('sonnet46T')],
          stores,
        }),
      ),
    ).resolves.toMatchObject({
      available: false,
      model: {
        value: 'userFacingFixture',
        availability: 'missing-key',
      },
    });
    expectModelOptionsRequested(['userFacingFixture']);
  });

  it('reports stale hidden model configuration directly', async () => {
    readModelAvailabilityInputsMock
      .mockReturnValueOnce(
        Effect.succeed([
          modelOption('sonnet46T', { availability: 'provider-key' }),
        ]),
      )
      .mockReturnValueOnce(Effect.succeed([]));

    await expect(
      run(
        selectCliRunnableModel('hiddenFixtureModel', {
          fallbackReason: 'explicit-override',
          stores,
        }),
      ),
    ).rejects.toThrow(
      'Model "hiddenFixtureModel" is configured but has no option data.',
    );
  });
});
