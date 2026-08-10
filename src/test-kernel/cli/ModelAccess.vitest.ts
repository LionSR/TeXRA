import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptyModelListMessageForCliMode,
  findCliModelAccessEntry,
  formatCliModelDetails,
  formatCliNoAvailableModelsRecovery,
  formatCliNoRunnableModelsMessage,
  formatModelStatusForCliMode,
  getCliModelAccessList,
  modelAccessLaunchBlockDescriptionForCliMode,
  modelSelectItemsForCliMode,
  noRunnableModelAccessReason,
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

function notIncludedModel(value: string): CliModelAccess {
  return model(value, {
    available: false,
    status: 'not included',
    model: modelOption(value, { availability: 'not-included', disabled: true }),
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
  includedModeAction: 'switch with /api included',
  loginAction: 'run /login',
  personalModeAction: 'switch with /api personal',
  configureKeyAction: 'configure a provider API key',
} as const;

// One included-access model and one provider-key model, so a resolution is
// runnable in exactly one API mode.
const API_MODE_SPLIT_ENTRIES: CliModelAccess[] = [
  model('sonnet46T', {
    model: modelOption('sonnet46T', { availability: 'included-access' }),
    status: 'included access',
  }),
  model('deepseekT', {
    model: modelOption('deepseekT', { availability: 'provider-key' }),
    status: 'api key set',
  }),
];

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

const GLM52_NOT_INCLUDED_ENTRY = model('glm52', {
  available: false,
  status: 'not included',
  model: modelOption('glm52', {
    label: 'GLM-5.2',
    availability: 'not-included',
    availabilityLabel: 'Not included',
    disabled: true,
  }),
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
      'Model "missingModel" is not available in the active API mode (missing api key). Available models: deepseekT.',
    );
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'environment',
      }),
    ).rejects.toThrow(
      'Model "missingModel" is not available in the active API mode (missing api key). Available models: deepseekT.',
    );
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'command-config',
      }),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "missingModel" is not available in the active API mode (missing api key). Available models: deepseekT. Using "deepseekT" instead.',
    });
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'history',
      }),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "missingModel" is not available in the active API mode (missing api key). Available models: deepseekT. Using "deepseekT" instead.',
    });
    await expect(
      resolveModelFromAccessList(entries, 'missingModel', {
        fallbackReason: 'builtin-default',
      }),
    ).resolves.toEqual({ model: 'deepseekT' });
  });

  it('rejects an explicit model that is unavailable in the active API mode', async () => {
    await expect(
      resolveModelFromAccessList(
        [model('sonnet46T'), notIncludedModel('opus48T')],
        'opus48T',
        { fallbackReason: 'explicit-override' },
      ),
    ).rejects.toThrow(
      'Model "opus48T" is not available in the active API mode (not included). Available models: sonnet46T.',
    );
  });

  it('falls back from stale defaults to the first currently runnable model', async () => {
    await expect(
      resolveModelFromAccessList(
        [notIncludedModel('opus48T'), model('deepseekT'), model('sonnet46T')],
        'opus48T',
        { fallbackReason: 'command-config' },
      ),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "opus48T" is not available in the active API mode (not included). Available models: deepseekT, sonnet46T. Using "deepseekT" instead.',
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
          availability: 'included-access',
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

  it('filters runnable models by active API mode when requested', () => {
    const entries = [
      model('sonnet46T', {
        model: modelOption('sonnet46T', {
          availability: 'included-access',
        }),
      }),
      model('deepseekT', {
        model: modelOption('deepseekT', {
          availability: 'provider-key',
        }),
      }),
      model('openrouterOnlyT', {
        model: modelOption('openrouterOnlyT', {
          availability: 'openrouter-key',
        }),
      }),
    ];

    expect(
      runnableCliModelAccessEntries(entries, 'included').map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['sonnet46T']);
    expect(
      runnableCliModelAccessEntries(entries, 'personal').map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['deepseekT', 'openrouterOnlyT']);
  });

  const DEEPSEEK_PROVIDER_KEY_ENTRY = model('deepseekT', {
    model: modelOption('deepseekT', { availability: 'provider-key' }),
    status: 'api key set',
  });

  it.each([
    {
      name: 'prefixes a provider-key status with the api label in personal mode',
      entry: DEEPSEEK_PROVIDER_KEY_ENTRY,
      apiMode: 'personal' as const,
      expected: 'api: api key set',
    },
    {
      name: 'marks included-access models available in included mode',
      entry: model('sonnet46T', {
        model: modelOption('sonnet46T', { availability: 'included-access' }),
        status: 'included access',
      }),
      apiMode: 'included' as const,
      expected: 'included access: available',
    },
    {
      name: 'marks provider-key models unavailable in included mode',
      entry: DEEPSEEK_PROVIDER_KEY_ENTRY,
      apiMode: 'included' as const,
      expected: 'included access: unavailable; API key set',
    },
    {
      name: 'summarizes relay quota exhaustion in included mode',
      entry: model('deepseekT', {
        model: modelOption('deepseekT', {
          availability: 'relay-quota-exhausted',
          availabilityLabel: 'Relay quota exhausted',
          disabled: true,
        }),
        status: 'relay quota exhausted',
      }),
      apiMode: 'included' as const,
      expected: 'included access: usage limit reached',
    },
    {
      name: 'summarizes the login requirement in included mode',
      entry: model('sonnet46T', {
        model: modelOption('sonnet46T', {
          availability: 'included-login-required',
          availabilityLabel: 'Login required',
          disabled: true,
        }),
        status: 'login required',
      }),
      apiMode: 'included' as const,
      expected: 'included access: sign-in required',
    },
    {
      name: 'passes ChatGPT subscription status through',
      entry: model('gpt56', {
        model: modelOption('gpt56', {
          availability: 'subscription-access',
          availabilityLabel: 'ChatGPT subscription',
        }),
        status: 'chatgpt subscription',
      }),
      apiMode: 'included' as const,
      expected: 'chatgpt subscription',
    },
    {
      name: 'passes Grok subscription status through',
      entry: model('grok45', {
        model: modelOption('grok45', {
          availability: 'subscription-access',
          availabilityLabel: 'Grok subscription',
          provider: 'xai',
        }),
        status: 'grok subscription',
      }),
      apiMode: 'included' as const,
      expected: 'grok subscription',
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
      apiMode: 'personal' as const,
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
      apiMode: 'personal' as const,
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
      apiMode: 'personal' as const,
      codingPlan: true,
      expected: 'api: openrouter key',
    },
  ])(
    'formats model picker status: $name',
    ({ entry, apiMode, expected, codingPlan }) => {
      if (codingPlan !== undefined)
        getGLMCodingPlanMock.mockReturnValue(codingPlan);
      expect(formatModelStatusForCliMode(entry, apiMode)).toBe(expected);
    },
  );

  it('builds model picker rows from the access-list source of truth', () => {
    const rows = modelSelectItemsForCliMode(
      [
        model('sonnet46T', {
          model: modelOption('sonnet46T', {
            label: 'Sonnet',
            availability: 'included-access',
          }),
        }),
        model('deepseekT', {
          model: modelOption('deepseekT', {
            label: 'DeepSeek',
            availability: 'provider-key',
          }),
        }),
        model('openrouterOnlyT', {
          model: modelOption('openrouterOnlyT', {
            label: 'OpenRouter Only',
            availability: 'openrouter-key',
          }),
          status: 'openrouter key',
        }),
        model('opus48T', {
          available: false,
          model: modelOption('opus48T', {
            label: 'Opus',
            availability: 'not-included',
            disabled: true,
          }),
          status: 'not included',
        }),
        model('gpt54', {
          model: modelOption('gpt54', {
            label: 'GPT-5.4',
            availability: 'included-access',
          }),
        }),
      ],
      'included',
    );

    expect(rows.map((row) => row.value)).toEqual(['sonnet46T', 'gpt54']);
    expect(rows.map((row) => row.description)).toEqual([
      'included access: available',
      'included access: available',
    ]);
  });

  it('shows personal-key model picker rows for personal API mode', () => {
    const rows = modelSelectItemsForCliMode(
      [
        model('sonnet46T', {
          model: modelOption('sonnet46T', {
            label: 'Sonnet',
            availability: 'included-access',
          }),
          status: 'included access',
        }),
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
      ],
      'personal',
    );

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
      modelSelectItemsForCliMode(
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
        'personal',
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
      modelSelectItemsForCliMode(
        [
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
          notIncludedModel('opus48T'),
        ],
        'included',
      ),
    ).toEqual([]);
  });

  it('classifies signed-out included access separately from other included outages', () => {
    expect(
      noRunnableModelAccessReason(
        [
          model('sonnet46T', {
            available: false,
            status: 'login required',
            model: modelOption('sonnet46T', {
              availability: 'included-login-required',
              disabled: true,
            }),
          }),
        ],
        'included',
      ),
    ).toBe('includedLoginRequired');
  });

  it('classifies personal and non-login included empty states by API mode', () => {
    expect(
      noRunnableModelAccessReason(
        [
          model('gemini31p', {
            available: false,
            status: 'missing api key',
            model: modelOption('gemini31p', {
              availability: 'missing-key',
              requiresKey: true,
            }),
          }),
        ],
        'personal',
      ),
    ).toBe('personal');
    expect(
      noRunnableModelAccessReason(
        [
          model('deepseekT', {
            available: false,
            status: 'relay quota exhausted',
            model: modelOption('deepseekT', {
              availability: 'relay-quota-exhausted',
              disabled: true,
            }),
          }),
        ],
        'included',
      ),
    ).toBe('included');
  });

  it('formats no-runnable model reasons for launch and model picker views', () => {
    expect(
      modelAccessLaunchBlockDescriptionForCliMode(
        [
          model('gpt54', {
            available: false,
            status: 'sign in required',
            model: modelOption('gpt54', {
              availability: 'included-login-required',
            }),
          }),
        ],
        'included',
      ),
    ).toBe('Sign in to use included access');
    expect(modelAccessLaunchBlockDescriptionForCliMode([], 'included')).toBe(
      'No models are available with included access',
    );
    expect(modelAccessLaunchBlockDescriptionForCliMode([], 'personal')).toBe(
      'No models are available with your own API keys',
    );
    expect(
      formatCliNoRunnableModelsMessage(
        'includedLoginRequired',
        INTERACTIVE_RECOVERY,
      ),
    ).toBe(
      'Sign in to use included access. Run /login or switch with /api personal.',
    );
    expect(
      formatCliNoRunnableModelsMessage('included', INTERACTIVE_RECOVERY),
    ).toBe(
      'No models are available with included access. Switch with /api personal or try again later.',
    );
    expect(
      formatCliNoRunnableModelsMessage('personal', INTERACTIVE_RECOVERY),
    ).toBe(
      'No models are available with your own API keys. Configure a provider API key or switch with /api included.',
    );
    expect(
      formatCliNoAvailableModelsRecovery('included', INTERACTIVE_RECOVERY),
    ).toBe(
      'Run /login for included access, or switch with /api personal after configuring a provider API key.',
    );
    expect(
      formatCliNoAvailableModelsRecovery('personal', INTERACTIVE_RECOVERY),
    ).toBe(
      'Configure a provider API key, or switch with /api included and run /login.',
    );
  });

  it('keeps defaults for omitted and nullish recovery actions', () => {
    expect(
      formatCliNoAvailableModelsRecovery('included', {
        personalModeAction: 'choose personal access',
      }),
    ).toBe(
      'Run `texra login` for included access, or choose personal access after configuring a provider API key.',
    );

    const runtimeNullishActions = {
      includedModeAction: null,
      loginAction: undefined,
      personalModeAction: null,
      configureKeyAction: undefined,
    };
    expect(
      // @ts-expect-error JavaScript callers can supply null at this boundary.
      formatCliNoAvailableModelsRecovery(undefined, runtimeNullishActions),
    ).toBe(
      'Run `texra login`, retry with `--api-mode included`, or add a provider API key with `texra setup`.',
    );
    expect(
      // @ts-expect-error JavaScript callers can supply null at this boundary.
      formatCliNoRunnableModelsMessage('included', runtimeNullishActions),
    ).toBe(
      'No models are available with included access. Retry with `--api-mode personal` or try again later.',
    );
  });

  it('formats empty model picker messages with caller-owned recovery actions', () => {
    expect(
      emptyModelListMessageForCliMode(
        [
          model('sonnet46T', {
            available: false,
            model: modelOption('sonnet46T', {
              availability: 'included-login-required',
              disabled: true,
            }),
            status: 'login required',
          }),
        ],
        'included',
        INTERACTIVE_RECOVERY,
      ),
    ).toBe(
      'Sign in to use included access. Run /login or switch with /api personal.',
    );
    expect(
      emptyModelListMessageForCliMode(
        [notIncludedModel('opus48T')],
        'included',
        INTERACTIVE_RECOVERY,
      ),
    ).toBe(
      'No models are available with included access. Switch with /api personal or try again later.',
    );
    expect(
      emptyModelListMessageForCliMode(
        [
          model('gemini31p', {
            available: false,
            model: modelOption('gemini31p', {
              availability: 'missing-key',
              requiresKey: true,
            }),
            status: 'missing api key',
          }),
        ],
        'personal',
        INTERACTIVE_RECOVERY,
      ),
    ).toBe(
      'No models are available with your own API keys. Configure a provider API key or switch with /api included.',
    );
  });

  it('rejects personal-key models in included TeXRA mode', async () => {
    await expect(
      resolveModelFromAccessList(API_MODE_SPLIT_ENTRIES, 'deepseekT', {
        fallbackReason: 'explicit-override',
        apiMode: 'included',
      }),
    ).rejects.toThrow(
      'Model "deepseekT" is not available in the active API mode (api key set). Available models: sonnet46T.',
    );
  });

  it('falls back from included TeXRA models in personal API mode', async () => {
    await expect(
      resolveModelFromAccessList(API_MODE_SPLIT_ENTRIES, 'sonnet46T', {
        fallbackReason: 'command-config',
        apiMode: 'personal',
      }),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice:
        'Model "sonnet46T" is not available in the active API mode (included access). Available models: deepseekT. Using "deepseekT" instead.',
    });
  });

  it('reports when no fallback model is runnable', async () => {
    await expect(
      resolveModelFromAccessList(MISSING_KEY_ONLY_ENTRIES, 'gemini31p', {
        fallbackReason: 'command-config',
      }),
    ).rejects.toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Run `texra login`, retry with `--api-mode included`, or add a provider API key with `texra setup`.',
    );
  });

  it('keeps personal-mode recovery scoped to provider keys or included mode', async () => {
    expect(formatCliNoAvailableModelsRecovery('personal')).toBe(
      'Add a provider API key with `texra setup`, or retry with `--api-mode included` and run `texra login`.',
    );
    await expect(
      resolveModelFromAccessList(MISSING_KEY_ONLY_ENTRIES, 'gemini31p', {
        fallbackReason: 'command-config',
        apiMode: 'personal',
      }),
    ).rejects.toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Add a provider API key with `texra setup`, or retry with `--api-mode included` and run `texra login`.',
    );
  });

  it('can format command-specific recovery hints for interactive chat', async () => {
    await expect(
      resolveModelFromAccessList(MISSING_KEY_ONLY_ENTRIES, 'gemini31p', {
        fallbackReason: 'command-config',
        noAvailableModelsMessage: 'Run `texra login` for included access.',
      }),
    ).rejects.toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Run `texra login` for included access.',
    );
  });

  it('rejects explicit retired hidden models before fallback', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([RETIRED_HAIKU3_OPTION]);

    await expect(
      selectCliRunnableModel('haiku3', {
        fallbackReason: 'explicit-override',
        apiMode: 'included',
        accessList: [],
      }),
    ).rejects.toThrow(
      'Model "haiku3" is not available in the active API mode (retired).',
    );
  });

  it.each([
    {
      name: 'shows a recovery hint for not-included models in model details',
      entry: GLM52_NOT_INCLUDED_ENTRY,
      apiMode: 'included' as const,
      contains: [
        'status: not included',
        'recovery: Add a provider API key with `texra setup`, then retry with `--api-mode personal`.',
      ],
      excludes: [],
    },
    {
      name: 'does not suggest included mode for not-included models in personal mode',
      entry: GLM52_NOT_INCLUDED_ENTRY,
      apiMode: 'personal' as const,
      contains: ['recovery: Add a provider API key with `texra setup`.'],
      excludes: ['`--api-mode included`'],
    },
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
      apiMode: 'included' as const,
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
      apiMode: 'personal' as const,
      contains: [
        'status: missing api key',
        'recovery: Add a provider API key with `texra setup`, or run `texra login` and retry with `--api-mode included` if your plan covers this model.',
      ],
      excludes: [],
    },
    {
      name: 'tells included-mode users to switch modes after adding a missing key',
      entry: GLM52_MISSING_KEY_ENTRY,
      apiMode: 'included' as const,
      contains: [
        'recovery: Add a provider API key with `texra setup`, then retry with `--api-mode personal`.',
      ],
      excludes: [],
    },
    {
      name: 'does not ask users to configure a key that is already present',
      entry: model('deepseekT', {
        available: false,
        status: 'api key set',
        model: modelOption('deepseekT', {
          availability: 'provider-key',
          availabilityLabel: 'API key set',
        }),
      }),
      apiMode: 'included' as const,
      contains: ['recovery: Retry with `--api-mode personal`.'],
      excludes: ['configuring a provider API key'],
    },
    {
      name: 'shows the included-mode recovery hint for included models in personal mode',
      entry: model('sonnet46T', {
        available: false,
        status: 'included access: available',
        model: modelOption('sonnet46T', {
          availability: 'included-access',
          availabilityLabel: 'Included access',
        }),
      }),
      apiMode: 'personal' as const,
      contains: ['recovery: Retry with `--api-mode included`.'],
      excludes: ['texra login'],
    },
    {
      name: 'does not repeat personal-mode advice when showing login-required models',
      entry: model('sonnet46T', {
        available: false,
        status: 'login required',
        model: modelOption('sonnet46T', {
          availability: 'included-login-required',
          availabilityLabel: 'Login required',
          disabled: true,
        }),
      }),
      apiMode: 'personal' as const,
      contains: [
        'recovery: Run `texra login` for included access, then retry with `--api-mode included`.',
      ],
      excludes: ['retry with `--api-mode personal`'],
    },
    {
      name: 'does not repeat personal-mode advice for quota-exhausted models',
      entry: model('sonnet46T', {
        available: false,
        status: 'relay quota exhausted',
        model: modelOption('sonnet46T', {
          availability: 'relay-quota-exhausted',
          availabilityLabel: 'Relay quota exhausted',
          disabled: true,
        }),
      }),
      apiMode: 'personal' as const,
      contains: ['recovery: Retry later.'],
      excludes: ['use `--api-mode personal`'],
    },
  ])('$name', ({ entry, apiMode, contains, excludes }) => {
    const text = formatCliModelDetails(entry, apiMode);

    for (const expected of contains) expect(text).toContain(expected);
    for (const absent of excludes) expect(text).not.toContain(absent);
  });

  it('carries the login-required verdict resolved by the model layer', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('deepseekT', {
        availability: 'included-login-required',
        availabilityLabel: 'Login required',
        requiresKey: false,
        disabled: true,
      }),
    ]);

    await expect(
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'login required',
        model: {
          value: 'deepseekT',
          availability: 'included-login-required',
          availabilityLabel: 'Login required',
          requiresKey: false,
          disabled: true,
        },
      },
    ]);
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

    await expect(
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
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

  it('preserves relay quota status for signed-in included-mode users', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('deepseekT', {
        availability: 'relay-quota-exhausted',
        availabilityLabel: 'Relay quota exhausted',
        requiresKey: false,
        disabled: true,
      }),
    ]);

    await expect(
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'relay quota exhausted',
        model: {
          value: 'deepseekT',
          availability: 'relay-quota-exhausted',
          availabilityLabel: 'Relay quota exhausted',
        },
      },
    ]);
  });

  it('marks only included-access models runnable in included TeXRA mode', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('gemini35f', {
        availability: 'included-access',
        availabilityLabel: 'Included access',
      }),
      modelOption('sonnet46T', {
        availability: 'included-access',
        availabilityLabel: 'Included access',
      }),
      modelOption('deepseekT', {
        availability: 'provider-key',
        availabilityLabel: 'API key set',
      }),
      modelOption('openrouterOnlyT', {
        availability: 'openrouter-key',
        availabilityLabel: 'OpenRouter key',
      }),
    ]);

    await expect(
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
      { model: { value: 'gemini35f' }, available: true },
      { model: { value: 'sonnet46T' }, available: true },
      { model: { value: 'deepseekT' }, available: false },
      { model: { value: 'openrouterOnlyT' }, available: false },
    ]);
  });

  it('marks only API-key models runnable in personal API mode', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('sonnet46T', {
        availability: 'included-access',
        availabilityLabel: 'Included access',
      }),
      modelOption('deepseekT', {
        availability: 'provider-key',
        availabilityLabel: 'API key set',
      }),
      modelOption('openrouterOnlyT', {
        availability: 'openrouter-key',
        availabilityLabel: 'OpenRouter key',
      }),
    ]);

    await expect(
      getCliModelAccessList({ apiMode: 'personal' }),
    ).resolves.toMatchObject([
      { model: { value: 'sonnet46T' }, available: false },
      { model: { value: 'deepseekT' }, available: true },
      { model: { value: 'openrouterOnlyT' }, available: true },
    ]);
  });

  it('loads explicit model ids for diagnostic lists', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('hiddenFixtureModel', {
        availability: 'not-included',
        availabilityLabel: 'Not included',
        disabled: true,
        requiresKey: false,
      }),
    ]);

    await expect(
      getCliModelAccessList({
        apiMode: 'included',
        models: ['hiddenFixtureModel'],
      }),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'not included',
        model: {
          value: 'hiddenFixtureModel',
          availability: 'not-included',
          availabilityLabel: 'Not included',
        },
      },
    ]);
    expectModelOptionsRequested(['hiddenFixtureModel']);
  });

  it('uses the loaded access list as the availability source of truth', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('sonnet46T', {
        availability: 'included-access',
        availabilityLabel: 'Included access',
        disabled: false,
        requiresKey: false,
      }),
      modelOption('deepseekT', {
        availability: 'provider-key',
        availabilityLabel: 'API key set',
        disabled: false,
        requiresKey: false,
      }),
    ]);

    const includedModeEntries = await getCliModelAccessList({
      apiMode: 'included',
    });

    expect(includedModeEntries).toMatchObject([
      { model: { value: 'sonnet46T' }, available: true },
      { model: { value: 'deepseekT' }, available: false },
    ]);
    expect(
      runnableCliModelAccessEntries(includedModeEntries, 'included').map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['sonnet46T']);
  });

  it('checks access for explicit models hidden from the visible model list', async () => {
    computeModelOptionsDataMock
      .mockResolvedValueOnce([
        modelOption('sonnet46T', { availabilityLabel: 'Included access' }),
      ])
      .mockResolvedValueOnce([
        modelOption('hiddenFixtureModel', { availabilityLabel: 'API key set' }),
      ]);

    await expect(
      selectCliRunnableModel('HIDDENFIXTUREMODEL', {
        fallbackReason: 'explicit-override',
      }),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expect(computeModelOptionsDataMock).toHaveBeenNthCalledWith(
      2,
      ['hiddenFixtureModel'],
    );
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
        apiMode: 'personal',
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
        apiMode: 'personal',
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
        apiMode: 'personal',
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
        modelOption('sonnet46T', { availabilityLabel: 'Included access' }),
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
