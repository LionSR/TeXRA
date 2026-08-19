import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptyModelListMessage,
  findCliModelAccessEntry,
  formatCliModelDetails,
  formatCliNoAvailableModelsRecovery,
  formatCliNoRunnableModelsMessage,
  formatModelStatusForCli,
  getCliModelAccessList,
  modelAccessLaunchBlockDescription,
  modelSelectItemsForCli,
  runnableCliModelAccessEntries,
  loadCliModelAccessEntry,
  selectCliRunnableModel,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelOptionData } from '@shared/schemas';

const getGLMCodingPlanMock = vi.hoisted(() => vi.fn());

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@utils/config/providerConfig', () => ({
  getGLMCodingPlan: getGLMCodingPlanMock,
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

const computeModelOptionsDataMock = vi.mocked(computeModelOptionsData);

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
      disabled: true,
      requiresKey: true,
    }),
  });
}

type ResolveCliRunnableModelOptions = Parameters<
  typeof selectCliRunnableModel
>[1];

function resolveModelFromAccessList(
  accessList: readonly CliModelAccess[],
  model: string,
  options: Omit<ResolveCliRunnableModelOptions, 'accessList'>,
) {
  return selectCliRunnableModel(model, { ...options, accessList });
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
  availabilityLabel: 'Retired',
  disabled: true,
  requiresKey: false,
});

const GLM52_MISSING_KEY_ENTRY = model('glm52', {
  available: false,
  status: 'missing api key',
  model: modelOption('glm52', {
    label: 'GLM-5.2',
    availability: 'missing-key',
    availabilityLabel: 'Missing API key',
    disabled: true,
    requiresKey: true,
  }),
});

function expectModelOptionsRequested(models: string[]): void {
  expect(computeModelOptionsDataMock).toHaveBeenCalledWith(models);
}

describe('CLI model access resolution', () => {
  beforeEach(() => {
    computeModelOptionsDataMock.mockReset();
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

  it('falls back from stale defaults to the first currently runnable model', async () => {
    await expect(
      resolveModelFromAccessList(
        [missingKeyModel('opus48T'), model('deepseekT'), model('sonnet46T')],
        'opus48T',
        { fallbackReason: 'command-config' },
      ),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "opus48T" is not available (missing api key). Available models: deepseekT, sonnet46T. Using "deepseekT" instead.',
    });
  });

  it('can fall back silently from an implicit default', async () => {
    await expect(
      resolveModelFromAccessList(
        [missingKeyModel('deepseekT'), model('gpt55')],
        'deepseekT',
        { fallbackReason: 'builtin-default' },
      ),
    ).resolves.toEqual({ model: 'gpt55' });
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
          disabled: true,
          requiresKey: true,
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
      name: 'labels a GLM provider-key row as GLM Coding Plan when the toggle is on',
      entry: model('glm52', {
        model: modelOption('glm52', {
          availability: 'provider-key',
          provider: 'glm',
        }),
        status: 'api key set',
      }),
      codingPlan: true,
      expected: 'api: GLM Coding Plan',
    },
    {
      name: 'keeps the plain api status for GLM provider-key rows when the toggle is off',
      entry: model('glm52', {
        model: modelOption('glm52', {
          availability: 'provider-key',
          provider: 'glm',
        }),
        status: 'api key set',
      }),
      codingPlan: false,
      expected: 'api: api key set',
    },
    {
      name: 'never claims GLM Coding Plan for an OpenRouter-routed GLM row',
      entry: model('glm52', {
        model: modelOption('glm52', {
          availability: 'openrouter-key',
          provider: 'glm',
        }),
        status: 'openrouter key',
      }),
      codingPlan: true,
      expected: 'api: openrouter key',
    },
  ])(
    'formats model picker status: $name',
    ({ entry, expected, codingPlan }) => {
      if (codingPlan !== undefined)
        getGLMCodingPlanMock.mockReturnValue(codingPlan);
      expect(formatModelStatusForCli(entry)).toBe(expected);
    },
  );

  it('builds model picker rows from the access-list source of truth', () => {
    const rows = modelSelectItemsForCli([
      model('deepseekT', {
        model: modelOption('deepseekT', {
          label: 'DeepSeek',
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
          requiresKey: true,
        }),
        status: 'missing api key',
      }),
    ]);

    expect(rows.map((row) => row.value)).toEqual([
      'deepseekT',
      'openrouterOnlyT',
    ]);
    expect(rows.map((row) => row.description)).toEqual([
      'api: api key set',
      'api: openrouter key',
    ]);
  });

  it('marks runnable model picker rows disabled when a live chat cannot switch formats', () => {
    expect(
      modelSelectItemsForCli(
        [
          model('sonnet46T', {
            model: modelOption('sonnet46T', {
              label: 'Sonnet',
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
          candidate === 'sonnet46T'
            ? 'different conversation format; start new chat'
            : undefined,
      ),
    ).toEqual([
      {
        value: 'sonnet46T',
        label: 'Sonnet',
        description:
          'different conversation format; start new chat; api: api key set',
        disabled: true,
      },
      {
        value: 'gpt55',
        label: 'GPT-5.5',
        description: 'api: api key set',
        disabled: false,
      },
    ]);
  });

  it('treats filtered-empty model picker rows as non-actionable', () => {
    expect(
      modelSelectItemsForCli([
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
            requiresKey: true,
          }),
          status: 'missing api key',
        }),
        missingKeyModel('opus48T'),
      ]),
    ).toEqual([]);
  });

  it('formats no-runnable model reasons for launch and model picker views', () => {
    expect(modelAccessLaunchBlockDescription()).toBe('No models are available');
    expect(formatCliNoRunnableModelsMessage(INTERACTIVE_RECOVERY)).toBe(
      'No models are available. Configure a provider API key.',
    );
    expect(formatCliNoAvailableModelsRecovery(INTERACTIVE_RECOVERY)).toBe(
      'Configure a provider API key.',
    );
  });

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

  it('formats empty model picker messages with caller-owned recovery actions', () => {
    expect(emptyModelListMessage(INTERACTIVE_RECOVERY)).toBe(
      'No models are available. Configure a provider API key.',
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
    computeModelOptionsDataMock.mockResolvedValueOnce([RETIRED_HAIKU3_OPTION]);

    await expect(
      selectCliRunnableModel('haiku3', {
        fallbackReason: 'explicit-override',
        accessList: [],
      }),
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
          availabilityLabel: 'Retired',
          disabled: true,
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
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('gpt56', {
        availability: 'subscription-access',
        availabilityLabel: 'ChatGPT subscription',
        requiresKey: false,
        disabled: false,
      }),
    ]);

    await expect(getCliModelAccessList()).resolves.toMatchObject([
      {
        available: true,
        model: {
          value: 'gpt56',
          availability: 'subscription-access',
          requiresKey: false,
          disabled: false,
        },
      },
    ]);
  });

  it('loads explicit model ids for diagnostic lists', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('hiddenFixtureModel', {
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
        disabled: true,
        requiresKey: true,
      }),
    ]);

    await expect(
      getCliModelAccessList({ models: ['hiddenFixtureModel'] }),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'missing api key',
        model: {
          value: 'hiddenFixtureModel',
          availability: 'missing-key',
          availabilityLabel: 'Missing API key',
        },
      },
    ]);
    expectModelOptionsRequested(['hiddenFixtureModel']);
  });

  it('uses the loaded access list as the availability source of truth', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('sonnet46T', {
        availability: 'provider-key',
        availabilityLabel: 'API key set',
        disabled: false,
        requiresKey: false,
      }),
      modelOption('deepseekT', {
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
        disabled: true,
        requiresKey: true,
      }),
    ]);

    const entries = await getCliModelAccessList();

    expect(entries).toMatchObject([
      { model: { value: 'sonnet46T' }, available: true },
      { model: { value: 'deepseekT' }, available: false },
    ]);
    expect(
      runnableCliModelAccessEntries(entries).map((entry) => entry.model.value),
    ).toEqual(['sonnet46T']);
  });

  it('checks access for explicit models hidden from the visible model list', async () => {
    computeModelOptionsDataMock
      .mockResolvedValueOnce([
        modelOption('sonnet46T', { availabilityLabel: 'API key set' }),
      ])
      .mockResolvedValueOnce([
        modelOption('hiddenFixtureModel', { availabilityLabel: 'API key set' }),
      ]);

    await expect(
      selectCliRunnableModel('HIDDENFIXTUREMODEL', {
        fallbackReason: 'explicit-override',
      }),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expect(computeModelOptionsDataMock).toHaveBeenNthCalledWith(2, [
      'hiddenFixtureModel',
    ]);
  });

  it('checks hidden model access against a supplied visible model list', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('hiddenFixtureModel', {
        availability: 'provider-key',
        availabilityLabel: 'API key set',
      }),
    ]);

    await expect(
      selectCliRunnableModel('hiddenFixtureModel', {
        fallbackReason: 'explicit-override',
        accessList: [missingKeyModel('deepseekT')],
      }),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expectModelOptionsRequested(['hiddenFixtureModel']);
  });

  it('ignores stale lower-priority hidden candidates after a runnable winner', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([]);

    await expect(
      selectCliRunnableModel(
        [
          { model: 'sonnet46T', reason: 'explicit-override' },
          { model: 'hiddenFixtureModel', reason: 'environment' },
        ],
        {
          accessList: [model('sonnet46T')],
        },
      ),
    ).resolves.toEqual({ model: 'sonnet46T' });
  });

  it('resolves hidden model entries for diagnostic commands', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('hiddenFixtureModel', {
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
        disabled: true,
        requiresKey: true,
      }),
    ]);

    await expect(
      loadCliModelAccessEntry('HIDDENFIXTUREMODEL', {
        accessList: [model('sonnet46T')],
      }),
    ).resolves.toMatchObject({
      available: false,
      status: 'missing api key',
      model: {
        value: 'hiddenFixtureModel',
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
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

    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('userFacingFixture', {
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
        disabled: true,
        requiresKey: true,
      }),
    ]);

    await expect(
      loadCliModelAccessEntry('User Facing Fixture', {
        accessList: [model('sonnet46T')],
      }),
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
    computeModelOptionsDataMock
      .mockResolvedValueOnce([
        modelOption('sonnet46T', { availabilityLabel: 'API key set' }),
      ])
      .mockResolvedValueOnce([]);

    await expect(
      selectCliRunnableModel('hiddenFixtureModel', {
        fallbackReason: 'explicit-override',
      }),
    ).rejects.toThrow(
      'Model "hiddenFixtureModel" is configured but has no option data.',
    );
  });
});
