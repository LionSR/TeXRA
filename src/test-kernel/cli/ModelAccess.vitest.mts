import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cliModelFallbackModeForSource,
  findCliModelAccessEntry,
  formatCliNoAvailableModelsRecovery,
  getCliModelAccessList,
  noRunnableModelAccessReason,
  runnableCliModelAccessEntries,
  resolveCliRunnableModel,
  resolveCliRunnableModelFromAccessList,
  resolveCliRunnableModelWithAccessList,
  type CliModelAccess,
  type CliModelFallbackMode,
  type CliModelSelectionSource,
} from '@cli/runtime/modelAccess';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelOptionData } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
}));

vi.mock('llm-zoo', () => ({
  MODEL_CONFIGS: {
    hiddenFixtureModel: {},
  },
}));

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

describe('CLI model access resolution', () => {
  beforeEach(() => {
    computeModelOptionsDataMock.mockReset();
    mocks.authProvider.isAuthenticated.mockReset();
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
  });

  it('keeps the requested model when it is currently runnable', () => {
    expect(
      resolveCliRunnableModelFromAccessList(
        [model('sonnet46T'), model('opus48T')],
        'opus48T',
        { fallbackMode: 'reject' },
      ),
    ).toEqual({ model: 'opus48T' });
  });

  it('centralizes fallback policy by model source', () => {
    const expectedModes = {
      override: 'reject',
      env: 'reject',
      config: 'notice',
      workspace: 'notice',
      user: 'notice',
      history: 'notice',
      builtin: 'silent',
    } satisfies Record<CliModelSelectionSource, CliModelFallbackMode>;

    for (const [source, mode] of Object.entries(expectedModes)) {
      expect(
        cliModelFallbackModeForSource(source as CliModelSelectionSource),
      ).toBe(mode);
    }
  });

  it('rejects an explicit model that is unavailable in the active API mode', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [
          model('sonnet46T'),
          model('opus48T', {
            available: false,
            status: 'not included',
            model: modelOption('opus48T', {
              availability: 'not-included',
              disabled: true,
            }),
          }),
        ],
        'opus48T',
        { fallbackMode: 'reject' },
      ),
    ).toThrow(
      'Model "opus48T" is not available in the active API mode (not included). Available models: sonnet46T.',
    );
  });

  it('falls back from stale defaults to the first currently runnable model', () => {
    expect(
      resolveCliRunnableModelFromAccessList(
        [
          model('opus48T', {
            available: false,
            status: 'not included',
            model: modelOption('opus48T', {
              availability: 'not-included',
              disabled: true,
            }),
          }),
          model('deepseekT'),
          model('sonnet46T'),
        ],
        'opus48T',
        { fallbackMode: 'notice' },
      ),
    ).toEqual({
      model: 'deepseekT',
      notice:
        'Model "opus48T" is not available in the active API mode (not included). Available models: deepseekT, sonnet46T. Using "deepseekT" instead.',
    });
  });

  it('can fall back silently from an implicit default', () => {
    expect(
      resolveCliRunnableModelFromAccessList(
        [
          model('deepseekT', {
            available: false,
            status: 'missing api key',
            model: modelOption('deepseekT', {
              availability: 'missing-key',
              disabled: true,
              requiresKey: true,
            }),
          }),
          model('gpt55'),
        ],
        'deepseekT',
        { fallbackMode: 'silent' },
      ),
    ).toEqual({ model: 'gpt55' });
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

  it('rejects personal-key models in included relay mode', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [
          model('sonnet46T', {
            model: modelOption('sonnet46T', {
              availability: 'included-access',
            }),
            status: 'included access',
          }),
          model('deepseekT', {
            model: modelOption('deepseekT', {
              availability: 'provider-key',
            }),
            status: 'api key set',
          }),
        ],
        'deepseekT',
        { fallbackMode: 'reject', apiMode: 'included' },
      ),
    ).toThrow(
      'Model "deepseekT" is not available in the active API mode (api key set). Available models: sonnet46T.',
    );
  });

  it('falls back from included relay models in personal API mode', () => {
    expect(
      resolveCliRunnableModelFromAccessList(
        [
          model('sonnet46T', {
            model: modelOption('sonnet46T', {
              availability: 'included-access',
            }),
            status: 'included access',
          }),
          model('deepseekT', {
            model: modelOption('deepseekT', {
              availability: 'provider-key',
            }),
            status: 'api key set',
          }),
        ],
        'sonnet46T',
        { fallbackMode: 'notice', apiMode: 'personal' },
      ),
    ).toEqual({
      model: 'deepseekT',
      notice:
        'Model "sonnet46T" is not available in the active API mode (included access). Available models: deepseekT. Using "deepseekT" instead.',
    });
  });

  it('reports when no fallback model is runnable', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [
          model('gemini31p', {
            available: false,
            status: 'missing api key',
            model: modelOption('gemini31p', {
              availability: 'missing-key',
              disabled: true,
              requiresKey: true,
            }),
          }),
        ],
        'gemini31p',
        { fallbackMode: 'notice' },
      ),
    ).toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Run `texra login` for included relay access, retry with `--api-mode included`, or configure a provider API key.',
    );
  });

  it('keeps personal-mode recovery scoped to provider keys or included mode', () => {
    expect(formatCliNoAvailableModelsRecovery('personal')).toBe(
      'Configure a provider API key for personal mode, or retry with `--api-mode included` and run `texra login` for included relay access.',
    );
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [
          model('gemini31p', {
            available: false,
            status: 'missing api key',
            model: modelOption('gemini31p', {
              availability: 'missing-key',
              disabled: true,
              requiresKey: true,
            }),
          }),
        ],
        'gemini31p',
        { fallbackMode: 'notice', apiMode: 'personal' },
      ),
    ).toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Configure a provider API key for personal mode, or retry with `--api-mode included` and run `texra login` for included relay access.',
    );
  });

  it('can format command-specific recovery hints for interactive chat', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [
          model('gemini31p', {
            available: false,
            status: 'missing api key',
            model: modelOption('gemini31p', {
              availability: 'missing-key',
              disabled: true,
              requiresKey: true,
            }),
          }),
        ],
        'gemini31p',
        {
          fallbackMode: 'notice',
          noAvailableModelsMessage:
            'Run `texra login` for included relay access.',
        },
      ),
    ).toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Run `texra login` for included relay access.',
    );
  });

  it('marks explicitly included-mode models as login-required when signed out', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('deepseekT', {
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
        requiresKey: true,
        disabled: true,
      }),
    ]);
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(false);

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

  it('preserves relay quota status for signed-in included-mode users', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('deepseekT', {
        availability: 'relay-quota-exhausted',
        availabilityLabel: 'Relay quota exhausted',
        requiresKey: false,
        disabled: true,
      }),
    ]);
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(true);

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

  it('marks only included-access models runnable in included relay mode', async () => {
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
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
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
      resolveCliRunnableModel('HIDDENFIXTUREMODEL', {
        fallbackMode: 'reject',
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
      resolveCliRunnableModelWithAccessList(
        [
          model('deepseekT', {
            available: false,
            status: 'missing api key',
            model: modelOption('deepseekT', {
              availability: 'missing-key',
              disabled: true,
              requiresKey: true,
            }),
          }),
        ],
        'hiddenFixtureModel',
        {
          fallbackMode: 'reject',
          apiMode: 'personal',
        },
      ),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expect(computeModelOptionsDataMock).toHaveBeenCalledWith([
      'hiddenFixtureModel',
    ]);
  });

  it('reports stale hidden model configuration directly', async () => {
    computeModelOptionsDataMock
      .mockResolvedValueOnce([
        modelOption('sonnet46T', { availabilityLabel: 'Included access' }),
      ])
      .mockResolvedValueOnce([]);

    await expect(
      resolveCliRunnableModel('hiddenFixtureModel', {
        fallbackMode: 'reject',
      }),
    ).rejects.toThrow(
      'Model "hiddenFixtureModel" is configured but has no option data.',
    );
  });
});

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
